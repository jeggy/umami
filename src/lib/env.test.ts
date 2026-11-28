import { describe, expect, test } from 'vitest';
import { parseBooleanEnv } from './env';

describe('parseBooleanEnv', () => {
  test.each([undefined, '', '  '])('leaves %j unset', value => {
    expect(parseBooleanEnv(value)).toBeUndefined();
  });

  test.each(['0', 'false', 'FALSE', ' False ', ' 0'])('reads %j as off', value => {
    expect(parseBooleanEnv(value)).toBe(false);
  });

  test.each(['1', 'true', 'TRUE', 'yes', ' on '])('reads %j as on', value => {
    expect(parseBooleanEnv(value)).toBe(true);
  });
});
