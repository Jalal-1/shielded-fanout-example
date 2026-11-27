// Small pieces of the page that more than one part of it uses.
import { useEffect, useState } from 'react';
import { formatAmount } from './amounts';
import type { TokenInfo } from './backend';

/** "3 min 20 s". */
export const duration = (seconds: number): string =>
  seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;

/** A running clock, so a long wait is visibly still alive. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span className="elapsed">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}

/** The token balance, and what is on its way back while a transaction is in flight. */
export function BalanceLine(props: { token: TokenInfo; balance: bigint; arriving: bigint }) {
  const { token } = props;
  return (
    <p>
      Spendable balance:{' '}
      <strong data-testid="balance">
        {formatAmount(props.balance, token.decimals)} {token.symbol}
      </strong>
      {props.arriving > 0n && (
        <span className="hint">
          {' '}
          plus {formatAmount(props.arriving, token.decimals)} {token.symbol} coming back as change. A payment spends
          whole coins, so the rest of the coin is unavailable until the transaction finalizes.
        </span>
      )}
    </p>
  );
}
