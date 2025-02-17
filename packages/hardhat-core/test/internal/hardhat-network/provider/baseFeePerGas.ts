import { assert } from "chai";
import { Block } from "@ethereumjs/block";
import Common from "@ethereumjs/common";

import { workaroundWindowsCiFailures } from "../../../utils/workaround-windows-ci-failures";
import { PROVIDERS } from "../helpers/providers";
import {
  numberToRpcQuantity,
  rpcQuantityToBN,
} from "../../../../src/internal/core/jsonrpc/types/base-types";
import { EthereumProvider } from "../../../../src/types";
import { makeForkClient } from "../../../../src/internal/hardhat-network/provider/utils/makeForkClient";
import { ALCHEMY_URL } from "../../../setup";
import { rpcToBlockData } from "../../../../src/internal/hardhat-network/provider/fork/rpcToBlockData";

async function getLatestBaseFeePerGas(provider: EthereumProvider) {
  const block = await provider.send("eth_getBlockByNumber", ["latest", false]);

  if (block.baseFeePerGas === undefined) {
    return undefined;
  }

  return rpcQuantityToBN(block.baseFeePerGas);
}

async function assertLatestBaseFeePerGas(
  provider: EthereumProvider,
  expectedBaseFeePerGas: number
) {
  const baseFeePerGas = await getLatestBaseFeePerGas(provider);

  assert.isDefined(baseFeePerGas);
  assert.equal(baseFeePerGas!.toString(), expectedBaseFeePerGas.toString());
}

async function sendValueTransferTx(provider: EthereumProvider, sender: string) {
  await provider.send("eth_sendTransaction", [
    {
      from: sender,
      to: sender,
      gas: numberToRpcQuantity(21000),
    },
  ]);
}

async function mineBlockWithValueTransferTxs(
  provider: EthereumProvider,
  valueTransferTxs: number
) {
  await provider.send("evm_setAutomine", [false]);
  const [sender] = await provider.send("eth_accounts");

  for (let i = 0; i < valueTransferTxs; i++) {
    await sendValueTransferTx(provider, sender);
  }

  await provider.send("evm_mine");

  await provider.send("evm_setAutomine", [true]);
}

describe("Block's baseFeePerGas", function () {
  PROVIDERS.forEach(({ name, useProvider, isFork }) => {
    if (isFork) {
      this.timeout(50000);
    }

    workaroundWindowsCiFailures.call(this, { isFork });

    describe(`${name} provider`, function () {
      describe("Initial base fee per gas", function () {
        if (!isFork) {
          describe("When not forking from a remote network the first block must have the right value", function () {
            describe("With an initialBaseFeePerGas config value", function () {
              useProvider({ initialBaseFeePerGas: 123 });

              it("should use the given value", async function () {
                await assertLatestBaseFeePerGas(this.provider, 123);
              });
            });

            describe("Without an initialBaseFeePerGas config value", function () {
              useProvider({});

              it("should use the initial base fee from the EIP (i.e. 1gwei)", async function () {
                await assertLatestBaseFeePerGas(this.provider, 1_000_000_000);
              });
            });
          });
        } else {
          describe("When forking from a remote network the forked block must have the right value", function () {
            describe("With an initialBaseFeePerGas config value", function () {
              useProvider({ initialBaseFeePerGas: 123123 });

              it("should use the given value", async function () {
                await mineBlockWithValueTransferTxs(this.provider, 0);
                await assertLatestBaseFeePerGas(this.provider, 123123);
              });
            });

            describe("Without an initialBaseFeePerGas config value", function () {
              useProvider();

              it("Should use the same base fee as the one remote networks's forked block", async function () {
                if (ALCHEMY_URL === undefined || ALCHEMY_URL === "") {
                  this.skip();
                  return;
                }

                const blockNumber = await this.provider.send("eth_blockNumber");
                const { forkClient } = await makeForkClient({
                  jsonRpcUrl: ALCHEMY_URL!,
                });

                const remoteLatestBlockBaseFeePerGas = await forkClient.getBlockByNumber(
                  rpcQuantityToBN(blockNumber)
                );
                await assertLatestBaseFeePerGas(
                  this.provider,
                  remoteLatestBlockBaseFeePerGas!.baseFeePerGas!.toNumber()
                );
              });

              it("should compute the next base fee correctly", async function () {
                const latestBlockRpc = await this.provider.send(
                  "eth_getBlockByNumber",
                  ["latest", false]
                );

                const latestBlockData = rpcToBlockData({
                  ...latestBlockRpc,
                  transactions: [],
                });

                const latestBlock = Block.fromBlockData(
                  {
                    header: latestBlockData.header,
                  },
                  {
                    common: new Common({
                      chain: "mainnet",
                      hardfork: "london",
                    }),
                  }
                );

                const expectedNextBaseFee = latestBlock.header.calcNextBaseFee();

                await this.provider.send("evm_mine");

                await assertLatestBaseFeePerGas(
                  this.provider,
                  expectedNextBaseFee.toNumber()
                );
              });
            });
          });
        }
      });

      describe("Base fee adjustment", function () {
        // These tests will run 6 blocks:
        //   The first one will be empty,
        //   The second one will be 1/4 filled
        //   The third one will be 1/2 filled, matching the gas target exactly
        //   The forth will be 3/4 filled
        //   The fifth will be completely filled
        //
        // All of the tests have a blockGasLimit of 21_000 * 4, so blocks can
        // only accept 4 value transfer txs.
        //
        // The initialBaseFeePerGas is 1_000_000_000, so the gas fee of the
        // blocks will be:
        //   1. 1_000_000_000 -- empty
        //   2. 875_000_000 -- 1/4 full
        //   3. 820_312_500 -- 1/2 full
        //   4. 820_312_500 -- 3/4 full
        //   5. 871_582_031 -- full
        //   6. 980529784 -- doesn't matter if full or not

        async function validateTheNext6BlocksBaseFeePerGas(
          provider: EthereumProvider
        ) {
          await assertLatestBaseFeePerGas(provider, 1_000_000_000);

          await mineBlockWithValueTransferTxs(provider, 1);

          await assertLatestBaseFeePerGas(provider, 875_000_000);

          await mineBlockWithValueTransferTxs(provider, 2);

          await assertLatestBaseFeePerGas(provider, 820_312_500);

          await mineBlockWithValueTransferTxs(provider, 3);

          await assertLatestBaseFeePerGas(provider, 820_312_500);

          await mineBlockWithValueTransferTxs(provider, 4);

          await assertLatestBaseFeePerGas(provider, 871_582_031);

          await mineBlockWithValueTransferTxs(provider, 0);

          await assertLatestBaseFeePerGas(provider, 980_529_784);
        }

        if (!isFork) {
          describe("When not forking", function () {
            useProvider({
              blockGasLimit: 21000 * 4,
              initialBaseFeePerGas: 1_000_000_000,
            });

            it("should update the baseFeePerGas starting with the first block", async function () {
              await validateTheNext6BlocksBaseFeePerGas(this.provider);
            });
          });
        } else {
          describe("When not forking", function () {
            useProvider({
              blockGasLimit: 21000 * 4,
              initialBaseFeePerGas: 1_000_000_000,
            });

            it("should update the baseFeePerGas starting with the first block", async function () {
              // We mine an empty block first, to make the scenario match the non-forking one
              await mineBlockWithValueTransferTxs(this.provider, 0);
              await validateTheNext6BlocksBaseFeePerGas(this.provider);
            });
          });
        }
      });
    });
  });
});
