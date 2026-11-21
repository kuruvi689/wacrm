import { describe, it, expect } from 'vitest';
import {
  parsePlanLimitError,
  planLimitMessage,
  planLimitBody,
  planLimitResponse,
  PLAN_LIMIT_STATUS,
} from './plan-limit-error';

describe('parsePlanLimitError', () => {
  it('parses a contacts limit from a PostgREST-style error', () => {
    const info = parsePlanLimitError({
      code: 'P0001',
      message: 'plan_limit: contacts (50 of 50 used)',
    });
    expect(info).toEqual({ resource: 'contacts', used: 50, limit: 50 });
  });

  it('parses a members limit from an Error instance', () => {
    const info = parsePlanLimitError(new Error('plan_limit: members (3 of 3 used)'));
    expect(info).toEqual({ resource: 'members', used: 3, limit: 3 });
  });

  it('still recognises the prefix when the counts are missing', () => {
    expect(parsePlanLimitError({ message: 'plan_limit: contacts' })).toEqual({
      resource: 'contacts',
      used: null,
      limit: null,
    });
    expect(parsePlanLimitError({ message: 'plan_limit:' })?.resource).toBe('unknown');
  });

  it('returns null for unrelated errors and non-errors', () => {
    expect(parsePlanLimitError(null)).toBeNull();
    expect(parsePlanLimitError(undefined)).toBeNull();
    expect(parsePlanLimitError('plan_limit: contacts')).toBeNull();
    expect(parsePlanLimitError({ message: 'duplicate key value' })).toBeNull();
    expect(parsePlanLimitError({ message: 'contact plan_limit: x' })).toBeNull();
    expect(parsePlanLimitError({ message: 42 })).toBeNull();
  });
});

describe('planLimitMessage', () => {
  it('names the resource and the cap', () => {
    expect(planLimitMessage({ resource: 'contacts', used: 10, limit: 10 })).toMatch(
      /Contact limit reached \(10 on your plan\)/,
    );
    expect(planLimitMessage({ resource: 'members', used: 2, limit: 2 })).toMatch(
      /Team member limit reached/,
    );
  });

  it('has a generic fallback without a cap', () => {
    expect(planLimitMessage({ resource: 'unknown', used: null, limit: null })).toBe(
      'Plan limit reached. Upgrade your plan to continue.',
    );
  });
});

describe('planLimitResponse', () => {
  it('is a 402 with a machine-readable body', async () => {
    const info = { resource: 'contacts', used: 5, limit: 5 };
    const res = planLimitResponse(info);
    expect(res.status).toBe(PLAN_LIMIT_STATUS);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual(planLimitBody(info));
    expect(planLimitBody(info).code).toBe('plan_limit');
  });
});
