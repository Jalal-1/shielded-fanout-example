import { describe, expect, it, vi } from 'vitest';
import { sendFanout, totalOf, type FanoutWallet, type Payment } from '../fanout';

const TOKEN = 'ab'.repeat(32);
const payments: Payment[] = [
  { recipient: 'mn_shield-addr_preprod1aaa', amount: 1700n },
  { recipient: 'mn_shield-addr_preprod1bbb', amount: 2900n },
];

function fakeWallet(overrides: Partial<FanoutWallet> = {}) {
  const calls: string[] = [];
  const wallet: FanoutWallet = {
    makeTransfer: vi.fn(async () => {
      calls.push('makeTransfer');
      return { tx: 'c0ffee' };
    }),
    submitTransaction: vi.fn(async () => {
      calls.push('submitTransaction');
    }),
    ...overrides,
  };
  return { wallet, calls };
}

describe('sendFanout', () => {
  it('asks the wallet for ONE transfer that holds an output per recipient', async () => {
    const { wallet } = fakeWallet();
    await sendFanout(wallet, TOKEN, payments);

    expect(wallet.makeTransfer).toHaveBeenCalledTimes(1);
    expect(wallet.makeTransfer).toHaveBeenCalledWith([
      { kind: 'shielded', type: TOKEN, value: 1700n, recipient: 'mn_shield-addr_preprod1aaa' },
      { kind: 'shielded', type: TOKEN, value: 2900n, recipient: 'mn_shield-addr_preprod1bbb' },
    ]);
  });

  it('submits exactly the transaction the wallet built, once', async () => {
    const { wallet } = fakeWallet();
    expect(await sendFanout(wallet, TOKEN, payments)).toBe('c0ffee');
    expect(wallet.submitTransaction).toHaveBeenCalledTimes(1);
    expect(wallet.submitTransaction).toHaveBeenCalledWith('c0ffee');
  });

  it('reports the built transaction before submitting it', async () => {
    const { wallet, calls } = fakeWallet();
    await sendFanout(wallet, TOKEN, payments, (tx) => {
      calls.push(`onBuilt:${tx}`);
    });
    expect(calls).toEqual(['makeTransfer', 'onBuilt:c0ffee', 'submitTransaction']);
  });

  it('submits nothing when the user declines in the wallet', async () => {
    const declined = Object.assign(new Error('declined'), { code: 'Rejected' });
    const { wallet } = fakeWallet({ makeTransfer: vi.fn(async () => Promise.reject(declined)) });
    await expect(sendFanout(wallet, TOKEN, payments)).rejects.toBe(declined);
    expect(wallet.submitTransaction).not.toHaveBeenCalled();
  });

  it('refuses an empty payout', async () => {
    const { wallet } = fakeWallet();
    await expect(sendFanout(wallet, TOKEN, [])).rejects.toThrow(/at least one recipient/);
    expect(wallet.makeTransfer).not.toHaveBeenCalled();
  });
});

describe('totalOf', () => {
  it('adds up what the sender must hold', () => {
    expect(totalOf(payments)).toBe(4600n);
    expect(totalOf([])).toBe(0n);
  });
});
