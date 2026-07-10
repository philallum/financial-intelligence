import { describe, it, expect } from 'vitest';
import { classifyEventImpact } from '../calendar-ingester.js';

describe('classifyEventImpact', () => {
  describe('high impact events', () => {
    it('returns "high" for event names containing "NFP"', () => {
      expect(classifyEventImpact('NFP Release')).toBe('high');
    });

    it('returns "high" for event names containing "Non-Farm"', () => {
      expect(classifyEventImpact('Non-Farm Payrolls')).toBe('high');
    });

    it('returns "high" for event names containing "CPI"', () => {
      expect(classifyEventImpact('US CPI m/m')).toBe('high');
    });

    it('returns "high" for event names containing "GDP"', () => {
      expect(classifyEventImpact('Quarterly GDP q/q')).toBe('high');
    });

    it('returns "high" for event names containing "Rate Decision"', () => {
      expect(classifyEventImpact('ECB Rate Decision')).toBe('high');
    });

    it('is case-insensitive for high impact keywords', () => {
      expect(classifyEventImpact('us cpi year-over-year')).toBe('high');
      expect(classifyEventImpact('RATE DECISION - FED')).toBe('high');
      expect(classifyEventImpact('nfp employment change')).toBe('high');
      expect(classifyEventImpact('non-farm payrolls')).toBe('high');
      expect(classifyEventImpact('gdp growth rate')).toBe('high');
    });
  });

  describe('medium impact events', () => {
    it('returns "medium" for event names containing "PMI"', () => {
      expect(classifyEventImpact('Manufacturing PMI')).toBe('medium');
    });

    it('returns "medium" for event names containing "Retail Sales"', () => {
      expect(classifyEventImpact('Core Retail Sales m/m')).toBe('medium');
    });

    it('is case-insensitive for medium impact keywords', () => {
      expect(classifyEventImpact('services pmi')).toBe('medium');
      expect(classifyEventImpact('RETAIL SALES y/y')).toBe('medium');
    });
  });

  describe('low impact events', () => {
    it('returns "low" for event names not matching any keywords', () => {
      expect(classifyEventImpact('Building Permits')).toBe('low');
    });

    it('returns "low" for generic economic events', () => {
      expect(classifyEventImpact('Trade Balance')).toBe('low');
      expect(classifyEventImpact('Unemployment Claims')).toBe('low');
      expect(classifyEventImpact('Industrial Production')).toBe('low');
    });

    it('returns "low" for an empty string', () => {
      expect(classifyEventImpact('')).toBe('low');
    });
  });

  describe('priority ordering', () => {
    it('returns "high" when both high and medium keywords are present', () => {
      // Edge case: an event name contains both "GDP" and "PMI"
      expect(classifyEventImpact('GDP PMI Combined Report')).toBe('high');
    });
  });
});
