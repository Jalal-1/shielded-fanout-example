// @vitest-environment jsdom
//
// Clicks through the whole flow against the mock wallet: connect, deploy,
// mint 100, pay 17 and 29 in one transaction, end with 54.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { createMockChain, type MockChain } from '../mock/mock-chain';
import { FAUCET_URL } from '../wallet';

function start(options: { funded?: boolean } = {}): MockChain {
  const mock = createMockChain({ delayMs: 0, ...options });
  window.midnight = { mock: mock.wallet };
  render(<App backend={mock.backend} sampleAddresses={mock.sampleAddresses} pollMs={5} />);
  return mock;
}

const click = (name: RegExp | string) => fireEvent.click(screen.getByRole('button', { name }));
const type = (label: RegExp | string, value: string, index = 0) =>
  fireEvent.change(screen.getAllByLabelText(label)[index]!, { target: { value } });

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.midnight;
});

describe('the app, against the mock wallet', () => {
  it('pays two recipients in one transaction and leaves the change', async () => {
    const mock = start();

    click('Connect Mock wallet');
    await screen.findByText('Your shielded address');

    click('Deploy token');
    await screen.findByText('Token type');
    const tokenType = screen.getByText('Token type').nextElementSibling!.textContent!;

    type('Amount to mint', '100');
    click('Mint to my wallet');
    await waitFor(() => expect(screen.getByTestId('balance').textContent).toBe('100 FAN'));

    const [first, second] = mock.sampleAddresses;
    type('Shielded address', first!, 0);
    type(/^Amount \(FAN\)/, '17', 0);
    type('Shielded address', second!, 1);
    type(/^Amount \(FAN\)/, '29', 1);
    expect(screen.getByTestId('total').textContent).toBe('46 FAN');
    expect(screen.getByTestId('remaining').textContent).toBe('54 FAN');

    click('Send 2 payments in one transaction');
    await waitFor(() => expect(screen.getByTestId('payout-status').textContent).toBe('Finalized'));
    await waitFor(() => expect(screen.getByTestId('balance').textContent).toBe('54 FAN'));

    // Amounts are in the smallest unit: 2 decimals.
    expect(mock.received(first!, tokenType)).toBe(1700n);
    expect(mock.received(second!, tokenType)).toBe(2900n);
    expect(screen.getByTestId('payout-hash').textContent).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the token and the payout hash across a reload, but not the recipients', async () => {
    const mock = start();
    click('Connect Mock wallet');
    await screen.findByText('Your shielded address');
    click('Deploy token');
    await screen.findByText('Token type');
    click('Mint to my wallet');
    await waitFor(() => expect(screen.getByTestId('balance').textContent).toBe('100 FAN'));
    type('Shielded address', mock.sampleAddresses[0]!, 0);
    type(/^Amount \(FAN\)/, '17', 0);
    click('Remove recipient 2');
    click('Send 1 payment in one transaction');
    await waitFor(() => expect(screen.getByTestId('payout-status').textContent).toBe('Finalized'));
    const hash = screen.getByTestId('payout-hash').textContent;

    // "Reload": a fresh page, same browser storage, same wallet.
    cleanup();
    render(<App backend={mock.backend} pollMs={5} />);
    click('Connect Mock wallet');
    await screen.findByText('Token type');
    expect(screen.getByTestId('payout-hash').textContent).toBe(hash);
    expect(screen.getByTestId('balance').textContent).toBe('83 FAN');

    const stored = JSON.stringify({ ...localStorage });
    expect(stored).not.toContain(mock.sampleAddresses[0]);
    expect((screen.getAllByLabelText('Shielded address')[0] as HTMLInputElement).value).toBe('');
  });

  it('blocks a payout that is larger than the balance or has a bad address', async () => {
    const mock = start();
    click('Connect Mock wallet');
    await screen.findByText('Your shielded address');
    click('Deploy token');
    await screen.findByText('Token type');
    click('Mint to my wallet');
    await waitFor(() => expect(screen.getByTestId('balance').textContent).toBe('100 FAN'));

    type('Shielded address', mock.sampleAddresses[0]!, 0);
    type(/^Amount \(FAN\)/, '60', 0);
    type('Shielded address', mock.sampleAddresses[1]!, 1);
    type(/^Amount \(FAN\)/, '60', 1);
    const sendButton = screen.getByRole('button', { name: 'Send 2 payments in one transaction' }) as HTMLButtonElement;
    expect(screen.getByText('The total is more than your spendable balance.')).toBeTruthy();
    expect(sendButton.disabled).toBe(true);

    type(/^Amount \(FAN\)/, '10', 1);
    expect(sendButton.disabled).toBe(false);
    type('Shielded address', 'not-an-address', 1);
    expect(sendButton.disabled).toBe(true);
  });

  it('tells an unfunded user to use the faucet and generate tDUST, and unlocks nothing', async () => {
    start({ funded: false });
    click('Connect Mock wallet');
    await screen.findByText(/You need tDUST to pay transaction fees/);
    expect(screen.getByRole('link', { name: 'Preprod faucet' }).getAttribute('href')).toBe(FAUCET_URL);
    expect(screen.queryByRole('button', { name: 'Deploy token' })).toBeNull();
    expect(screen.getAllByText('You need tDUST first.').length).toBeGreaterThan(0);
  });
});
