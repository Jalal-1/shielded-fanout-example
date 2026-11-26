import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type ZswapCoinPublicKey = { bytes: Uint8Array };

export type ContractAddress = { bytes: Uint8Array };

export type Either<A, B> = { is_left: boolean; left: A; right: B };

export type Maybe<T> = { is_some: boolean; value: T };

export type ShieldedCoinInfo = { nonce: Uint8Array;
                                 color: Uint8Array;
                                 value: bigint
                               };

export type Witnesses<PS> = {
  wit_secretNonce(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: ZswapCoinPublicKey,
       amount_0: bigint,
       nonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, ShieldedCoinInfo>>;
  burn(context: __compactRuntime.CircuitContext<PS>,
       coin_0: ShieldedCoinInfo,
       amount_0: bigint,
       refundTo_0: ZswapCoinPublicKey): Promise<__compactRuntime.CircuitResults<PS, Maybe<ShieldedCoinInfo>>>;
  transferOwnership(context: __compactRuntime.CircuitContext<PS>,
                    newOwnerId_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  renounceOwnership(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  owner(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  totalMinted(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  tokenColor(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  name(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  symbol(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
}

export type ProvableCircuits<PS> = {
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: ZswapCoinPublicKey,
       amount_0: bigint,
       nonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, ShieldedCoinInfo>>;
  burn(context: __compactRuntime.CircuitContext<PS>,
       coin_0: ShieldedCoinInfo,
       amount_0: bigint,
       refundTo_0: ZswapCoinPublicKey): Promise<__compactRuntime.CircuitResults<PS, Maybe<ShieldedCoinInfo>>>;
  transferOwnership(context: __compactRuntime.CircuitContext<PS>,
                    newOwnerId_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  renounceOwnership(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  owner(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  totalMinted(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  tokenColor(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  name(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  symbol(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
}

export type PureCircuits = {
  _computeOwnerId(pk_0: Either<ZswapCoinPublicKey, ContractAddress>,
                  nonce_0: Uint8Array): Uint8Array;
}

export type Circuits<PS> = {
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: ZswapCoinPublicKey,
       amount_0: bigint,
       nonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, ShieldedCoinInfo>>;
  burn(context: __compactRuntime.CircuitContext<PS>,
       coin_0: ShieldedCoinInfo,
       amount_0: bigint,
       refundTo_0: ZswapCoinPublicKey): Promise<__compactRuntime.CircuitResults<PS, Maybe<ShieldedCoinInfo>>>;
  transferOwnership(context: __compactRuntime.CircuitContext<PS>,
                    newOwnerId_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  renounceOwnership(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  owner(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  _computeOwnerId(context: __compactRuntime.CircuitContext<PS>,
                  pk_0: Either<ZswapCoinPublicKey, ContractAddress>,
                  nonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  totalMinted(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  tokenColor(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  name(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  symbol(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
}

export type Ledger = {
  readonly _ownableIsInitialized: boolean;
  readonly _ownerCommitment: Uint8Array;
  readonly _counter: bigint;
  readonly _instanceSalt: Uint8Array;
  readonly _domain: Uint8Array;
  readonly _isInitialized: boolean;
  readonly _name: string;
  readonly _symbol: string;
  readonly _decimals: bigint;
  _totalMinted: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  _totalBurned: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
}

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               ownerId_0: Uint8Array,
               instanceSalt_0: Uint8Array,
               tokenDomain_0: Uint8Array,
               name__0: string,
               symbol__0: string,
               decimals__0: bigint): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
export declare const circuitSignatures: __compactRuntime.CircuitSignatures;
export declare const declaredInterfaces: __compactRuntime.DeclaredInterfaces;
