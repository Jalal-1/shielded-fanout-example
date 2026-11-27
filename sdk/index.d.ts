// One door to the Midnight wallet SDK, for the sake of the browser build.
//
// The app needs three entry points of the SDK: the main one, and the two that
// hold the pieces for the fast DUST sync. The SDK's DUST modules import each
// other in a circle, and when a bundler packs those three entry points
// separately it can put that circle in an order that fails at load time
// ("Cannot read properties of undefined"). Re-exporting them from one place,
// main entry first, makes the bundler pack them once, in the order that works.
//
// In Node none of this is needed: import the SDK's entry points directly.
export * from '@midnightntwrk/wallet-sdk';
export { V1Builder } from '@midnightntwrk/wallet-sdk/dust/v1';
export { V2Builder, SyncService as DustSync } from '@midnightntwrk/wallet-sdk/dust/v2';
// The SDK speaks in the `effect` library's Option type where a value may be absent.
export { Option } from 'effect';
