'use strict';

// CODEOWNERS-style path patterns, also used for the Copilot allowlist/blocklist:
// - a leading `/` or a `/` in the middle anchors the pattern at the repo root,
//   otherwise it matches at any depth
// - a trailing `/` matches only directory contents
// - `*` and `?` stay within one path segment, `**` crosses segments
// - a pattern whose last segment has no wildcard also matches everything below it
function patternToRegExp(pattern) {
  let p = pattern.trim();
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);

  let body = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        body += '(?:.*/)?';
        i += 2;
      } else {
        body += '.*';
        i += 1;
      }
    } else if (c === '*') {
      body += '[^/]*';
    } else if (c === '?') {
      body += '[^/]';
    } else {
      body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  const lastSegment = p.split('/').pop();
  const prefix = anchored ? '' : '(?:.*/)?';
  let suffix = '';
  if (dirOnly) suffix = '/.*';
  else if (!/[*?]/.test(lastSegment)) suffix = '(?:/.*)?';
  return new RegExp(`^${prefix}${body}${suffix}$`);
}

function matchesAny(path, patterns) {
  return (patterns || []).some((p) => patternToRegExp(p).test(path));
}

function parseCodeowners(text) {
  const rules = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern, owners, regex: patternToRegExp(pattern) });
  }
  return rules;
}

// Last matching rule wins, as in GitHub. A matching rule with no owners un-owns the path.
function ownersFor(path, rules) {
  let owners = [];
  for (const rule of rules) if (rule.regex.test(path)) owners = rule.owners;
  return owners;
}

const DECISIVE_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

const byTime = (reviews) => [...reviews].sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));

function latestDecisiveReviews(reviews) {
  const byUser = new Map();
  for (const r of byTime(reviews)) {
    if (!r.user || !DECISIVE_STATES.has(r.state)) continue;
    byUser.set(r.user.login, r);
  }
  return byUser;
}

const DEFAULTS = {
  copilotLogin: 'copilot-pull-request-reviewer[bot]',
  copilotAllowlist: [],
  copilotBlocklist: [],
  requireApprovalOnHead: true,
  trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
  maxDescriptionLength: 140,
};

function withDefaults(config) {
  return { ...DEFAULTS, ...(config || {}) };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Decide whether the PR satisfies the review policy. Pure: all GitHub data is passed in.
 *
 * Every changed path (and the old path of a rename) must be covered by either
 *  - Copilot's approval of the current head, if the path is on the allowlist and not on the blocklist, or
 *  - an approval of the current head from one of the path's code owners (the PR author excluded), or
 *  - for paths with no other code owner, an approval from any trusted collaborator.
 *
 * @param {object} args
 * @param {object} args.config         review-policy.json contents
 * @param {object} args.pr             REST pull request object
 * @param {object[]} args.files        REST PR files
 * @param {object[]} args.reviews      REST PR reviews
 * @param {object[]} args.codeowners   output of parseCodeowners
 * @param {Object<string, string[]>} [args.teamMembers] team owner ("@org/team", lowercase) -> member logins (lowercase)
 * @returns {{state: 'success'|'pending', description: string, copilotApproved: boolean, approvers: string[], paths: object[], notes: string[]}}
 */
function evaluate({ config: rawConfig, pr, files, reviews, codeowners, teamMembers = {} }) {
  const config = withDefaults(rawConfig);
  const head = pr.head.sha;
  const author = pr.user.login.toLowerCase();
  const copilotLogin = config.copilotLogin.toLowerCase();
  const notes = [];

  const onHead = (r) => !config.requireApprovalOnHead || r.commit_id === head;
  const latest = latestDecisiveReviews(reviews);

  // Copilot's verdict is its latest submitted review of any state: a later 🟡/🔴 (COMMENTED)
  // review revokes an earlier 🟢 approval, unlike a human's follow-up comment.
  const copilotLatest = byTime(reviews)
    .filter((r) => r.user && r.user.login.toLowerCase() === copilotLogin && r.state !== 'PENDING')
    .pop();
  const copilotApproved = Boolean(copilotLatest && copilotLatest.state === 'APPROVED' && onHead(copilotLatest));

  const approvers = [];
  for (const [login, r] of latest) {
    if (r.state !== 'APPROVED' || !onHead(r)) continue;
    const l = login.toLowerCase();
    if (l !== copilotLogin && l !== author && r.user.type !== 'Bot') {
      approvers.push({ login: l, trusted: config.trustedAssociations.includes(r.author_association) });
    }
  }

  const isOwner = (owner, login) => {
    const o = owner.toLowerCase();
    if (!o.startsWith('@')) return false;
    if (o.includes('/')) return (teamMembers[o] || []).includes(login);
    return o === `@${login}`;
  };

  const paths = [];
  for (const f of files) {
    paths.push(f.filename);
    if (f.previous_filename && f.previous_filename !== f.filename) paths.push(f.previous_filename);
  }

  const results = paths.map((path) => {
    const owners = ownersFor(path, codeowners);
    const otherOwners = owners.filter((o) => o.toLowerCase() !== `@${author}`);
    const copilotEligible = matchesAny(path, config.copilotAllowlist) && !matchesAny(path, config.copilotBlocklist);

    let coveredBy = null;
    if (copilotEligible && copilotApproved) {
      coveredBy = 'Copilot';
    } else if (otherOwners.length) {
      const a = approvers.find((ap) => otherOwners.some((o) => isOwner(o, ap.login)));
      if (a) coveredBy = `@${a.login}`;
    } else {
      const a = approvers.find((ap) => ap.trusted);
      if (a) coveredBy = `@${a.login}`;
    }

    const needs = otherOwners.length ? [...otherOwners] : ['a maintainer'];
    if (copilotEligible) needs.push('Copilot');
    return { path, owners, copilotEligible, coveredBy, needs };
  });

  const unresolvable = new Set();
  for (const r of results) {
    for (const o of r.owners) {
      if (!o.startsWith('@')) unresolvable.add(o);
      else if (o.includes('/') && !(o.toLowerCase() in teamMembers)) unresolvable.add(o);
    }
  }
  if (unresolvable.size) notes.push(`Could not resolve owners: ${[...unresolvable].join(', ')}`);

  if (pr.changed_files > files.length) {
    notes.push(`Only ${files.length} of ${pr.changed_files} files could be listed`);
    return {
      state: 'pending',
      description: truncate(`Too many files to evaluate (${pr.changed_files}); needs a manual decision`, config.maxDescriptionLength),
      copilotApproved,
      approvers: approvers.map((a) => a.login),
      paths: results,
      notes,
    };
  }

  if (!results.length) {
    const ok = copilotApproved || approvers.some((a) => a.trusted);
    return {
      state: ok ? 'success' : 'pending',
      description: ok ? 'Approved (no file changes)' : 'Needs any approval (no file changes)',
      copilotApproved,
      approvers: approvers.map((a) => a.login),
      paths: results,
      notes,
    };
  }

  const uncovered = results.filter((r) => !r.coveredBy);
  let description;
  if (!uncovered.length) {
    const counts = new Map();
    for (const r of results) counts.set(r.coveredBy, (counts.get(r.coveredBy) || 0) + 1);
    description = `Approved by ${[...counts].map(([who, n]) => `${who} (${plural(n, 'file')})`).join(', ')}`;
  } else {
    const groups = new Map();
    for (const r of uncovered) {
      const key = r.needs.join(' or ');
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    description = `Needs ${[...groups].map(([who, n]) => `${who} (${plural(n, 'file')})`).join('; ')}`;
  }

  return {
    state: uncovered.length ? 'pending' : 'success',
    description: truncate(description, config.maxDescriptionLength),
    copilotApproved,
    approvers: approvers.map((a) => a.login),
    paths: results,
    notes,
  };
}

module.exports = { patternToRegExp, matchesAny, parseCodeowners, ownersFor, latestDecisiveReviews, evaluate, DEFAULTS };
