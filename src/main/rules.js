'use strict';
// Outlook-style rules: conditions evaluated against each message, actions that decide where it is filed
// in the PST and what happens to it in Gmail. Rules can also be compiled to a Gmail search query so they
// can be previewed / run against mail already sitting in Gmail.

const crypto = require('crypto');

const FIELDS = {
  from: 'From (name or address)',
  to: 'To',
  cc: 'Cc',
  anyRecipient: 'To or Cc',
  subject: 'Subject',
  body: 'Body',
  fromDomain: 'Sender domain',
  label: 'Gmail label',
  hasAttachment: 'Has attachment',
  isNewsletter: 'Is a newsletter / mailing list',
  unread: 'Is unread',
  olderThanDays: 'Older than (days)',
  largerThanKB: 'Larger than (KB)',
};

const OPERATORS = {
  contains: 'contains',
  notContains: 'does not contain',
  equals: 'is',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matches: 'matches regex',
};

const ACTIONS = {
  moveToFolder: 'Move to PST folder',
  addCategory: 'Assign category',
  markRead: 'Mark as read',
  flag: 'Flag for follow-up',
  keepInGmail: 'Archive to PST but keep in Gmail',
  trashInGmail: 'Archive to PST and move to Gmail Trash',
  skip: 'Do not archive (leave in Gmail)',
  deleteWithoutArchive: 'Move to Gmail Trash without archiving',
};

const BOOLEAN_FIELDS = new Set(['hasAttachment', 'isNewsletter', 'unread']);
const NUMERIC_FIELDS = new Set(['olderThanDays', 'largerThanKB']);

function newRule(partial = {}) {
  return {
    id: crypto.randomUUID(),
    name: 'New rule',
    enabled: true,
    match: 'all',
    conditions: [{ field: 'from', op: 'contains', value: '' }],
    actions: [{ type: 'moveToFolder', value: 'Inbox' }],
    stopProcessing: true,
    ...partial,
  };
}

// ctx: { from, fromAddress, to, cc, subject, body, labels[], hasAttachment, isNewsletter, unread, date, sizeKB }
function testCondition(c, ctx) {
  if (BOOLEAN_FIELDS.has(c.field)) {
    const want = c.value === undefined || c.value === '' || c.value === true || String(c.value).toLowerCase() === 'true';
    return !!ctx[c.field] === want;
  }
  if (c.field === 'olderThanDays') return (Date.now() - new Date(ctx.date).getTime()) / 86400000 > Number(c.value);
  if (c.field === 'largerThanKB') return ctx.sizeKB > Number(c.value);

  let haystacks;
  switch (c.field) {
    case 'from':
      haystacks = [ctx.from, ctx.fromAddress];
      break;
    case 'fromDomain':
      haystacks = [(ctx.fromAddress || '').split('@')[1] || ''];
      break;
    case 'anyRecipient':
      haystacks = [ctx.to, ctx.cc];
      break;
    case 'label':
      haystacks = ctx.labels || [];
      break;
    default:
      haystacks = [ctx[c.field]];
  }
  haystacks = haystacks.map((h) => String(h || ''));
  const needle = String(c.value || '');
  const lower = needle.toLowerCase();
  const test = (h) => {
    const hl = h.toLowerCase();
    switch (c.op) {
      case 'contains':
        return hl.includes(lower);
      case 'notContains':
        return !hl.includes(lower);
      case 'equals':
        return hl === lower;
      case 'startsWith':
        return hl.startsWith(lower);
      case 'endsWith':
        return hl.endsWith(lower);
      case 'matches':
        try {
          return new RegExp(needle, 'i').test(h);
        } catch {
          return false;
        }
      default:
        return false;
    }
  };
  // A negative condition must hold for every field; a positive one for any field.
  return c.op === 'notContains' ? haystacks.every(test) : haystacks.some(test);
}

function ruleMatches(rule, ctx) {
  const conds = (rule.conditions || []).filter((c) => c.field);
  if (!conds.length) return false;
  return rule.match === 'any' ? conds.some((c) => testCondition(c, ctx)) : conds.every((c) => testCondition(c, ctx));
}

/**
 * Runs every enabled rule in order and merges their actions into one plan.
 * @returns {{folder?:string, categories:string[], markRead:boolean, flag:boolean,
 *            gmail:'default'|'keep'|'trash', skip:boolean, deleteOnly:boolean, matched:string[]}}
 */
function evaluate(rules, ctx) {
  const plan = { folder: undefined, categories: [], markRead: false, flag: false, gmail: 'default', skip: false, deleteOnly: false, matched: [] };
  for (const rule of rules) {
    if (!rule.enabled || !ruleMatches(rule, ctx)) continue;
    plan.matched.push(rule.name);
    applyActions(plan, rule.actions);
    if (rule.stopProcessing) break;
  }
  return plan;
}

function applyActions(plan, actions) {
  for (const a of actions || []) {
    switch (a.type) {
      case 'moveToFolder':
        if (a.value && plan.folder === undefined) plan.folder = a.value;
        break;
      case 'addCategory':
        if (a.value && !plan.categories.includes(a.value)) plan.categories.push(a.value);
        break;
      case 'markRead':
        plan.markRead = true;
        break;
      case 'flag':
        plan.flag = true;
        break;
      case 'keepInGmail':
        plan.gmail = 'keep';
        break;
      case 'trashInGmail':
        plan.gmail = 'trash';
        break;
      case 'skip':
        plan.skip = true;
        break;
      case 'deleteWithoutArchive':
        plan.deleteOnly = true;
        break;
    }
  }
}

function quote(v) {
  const s = String(v).replace(/"/g, '');
  return /[\s()]/.test(s) ? `"${s}"` : s;
}

/**
 * Compile a rule to a Gmail search query. Gmail search is word-based rather than substring-based, so the
 * query is used to find candidates and every candidate is re-checked locally with ruleMatches().
 * Conditions Gmail cannot express are left out of the query (they still filter locally).
 */
function toGmailQuery(rule) {
  const parts = [];
  for (const c of rule.conditions || []) {
    const v = c.value;
    const neg = c.op === 'notContains' ? '-' : '';
    const canText = ['contains', 'notContains', 'equals', 'startsWith', 'endsWith'].includes(c.op);
    let q = null;
    switch (c.field) {
      case 'from':
      case 'fromDomain':
        if (canText && v) q = `${neg}from:${quote(v)}`;
        break;
      case 'to':
        if (canText && v) q = `${neg}to:${quote(v)}`;
        break;
      case 'cc':
        if (canText && v) q = `${neg}cc:${quote(v)}`;
        break;
      case 'anyRecipient':
        if (canText && v) q = `${neg}{to:${quote(v)} cc:${quote(v)}}`;
        break;
      case 'subject':
        if (canText && v) q = `${neg}subject:${quote(v)}`;
        break;
      case 'body':
        if (canText && v) q = `${neg}${quote(v)}`;
        break;
      case 'label':
        if (canText && v) q = `${neg}label:${quote(String(v).replace(/[\s/]/g, '-'))}`;
        break;
      case 'hasAttachment':
        q = String(v) === 'false' ? '-has:attachment' : 'has:attachment';
        break;
      case 'unread':
        q = String(v) === 'false' ? 'is:read' : 'is:unread';
        break;
      case 'olderThanDays':
        if (Number(v) > 0) q = `older_than:${Math.floor(Number(v))}d`;
        break;
      case 'largerThanKB':
        if (Number(v) > 0) q = `larger:${Math.floor(Number(v))}k`;
        break;
    }
    if (q) parts.push(q);
    else if (rule.match === 'any') return null; // an OR with an inexpressible term cannot be narrowed safely
  }
  if (!parts.length) return null;
  return rule.match === 'any' ? `{${parts.join(' ')}}` : parts.join(' ');
}

module.exports = { FIELDS, OPERATORS, ACTIONS, newRule, evaluate, ruleMatches, toGmailQuery };
