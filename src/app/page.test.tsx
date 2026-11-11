import { render } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { getTestRouter } from '@/test/navigation';
import RootPage from './page';

beforeEach(() => {
  localStorage.clear();
});

// The session cookie is httpOnly, so the page cannot tell a signed-in visitor from a signed-out
// one. Signed-out visitors are sent to /login by the app once the session check fails.
test('sends visitors to their websites', () => {
  render(<RootPage />);

  expect(getTestRouter().replace).toHaveBeenCalledWith('/websites');
});

test('sends visitors back to their last team', () => {
  localStorage.setItem('umami.last-team', JSON.stringify('team-1'));

  render(<RootPage />);

  expect(getTestRouter().replace).toHaveBeenCalledWith('/teams/team-1/websites');
});
