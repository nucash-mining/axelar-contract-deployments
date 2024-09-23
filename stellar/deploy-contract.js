'use strict';

const { Contract, Address, nativeToScVal, scValToNative } = require('@stellar/stellar-sdk');
const { Command, Option } = require('commander');
const { execSync } = require('child_process');
const { loadConfig, printInfo, saveConfig } = require('../evm/utils');
const {
    getNetworkPassphrase,
    getWallet,
    broadcast,
} = require('./utils');
const { addEnvOption, getDomainSeparator } = require('../common');
const { weightedSignersToScVal } = require('./type-utils');
const { ethers } = require('hardhat');
const {
    utils: { arrayify, id },
} = ethers;
require('./cli-utils');

async function getInitializeArgs(config, chain, contractName, wallet, options) {
    const owner = nativeToScVal(Address.fromString(wallet.publicKey()), { type: 'address' });

    switch (contractName) {
        case 'axelar_gateway': {
            const authAddress = chain.contracts?.axelar_auth_verifier?.address;

            if (!authAddress) {
                throw new Error('Missing axelar_auth_verifier contract address');
            }

            return {
                authAddress: nativeToScVal(authAddress, { type: 'address' }),
                owner,
            };
        }

        case 'axelar_auth_verifier': {
            const previousSignersRetention = nativeToScVal(15);
            const domainSeparator = nativeToScVal(Buffer.from(arrayify(await getDomainSeparator(config, chain, options))));
            const minimumRotationDelay = nativeToScVal(0);
            const nonce = options.nonce ? arrayify(id(options.nonce)) : Array(32).fill(0);
            const initialSigners = nativeToScVal([
                weightedSignersToScVal({
                    nonce,
                    signers: [
                        {
                            signer: wallet.publicKey(),
                            weight: 1,
                        },
                    ],
                    threshold: 1,
                }),
            ]);

            return {
                owner,
                previousSignersRetention,
                domainSeparator,
                minimumRotationDelay,
                initialSigners,
            };
        }

        case 'axelar_operators':
            return { owner };
        default:
            throw new Error(`Unknown contract: ${contractName}`);
    }
}

async function postDeployGateway(chain, wallet, options) {
    printInfo('Transferring ownership of auth contract to the gateway');
    const auth = new Contract(chain.contracts.axelar_auth_verifier.address);
    const operation = auth.call('transfer_ownership', nativeToScVal(chain.contracts.axelar_gateway.address, { type: 'address' }));
    await broadcast(operation, wallet, chain, 'Transferred ownership', options);
}

const postDeployFunctions = {
    axelar_gateway: postDeployGateway,
};

function serializeValue(value) {
    if (value instanceof Uint8Array) {
        return Buffer.from(value).toString('hex');
    }

    if (Array.isArray(value)) {
        return value.map(serializeValue);
    }

    if (typeof value === 'bigint') {
        return value.toString();
    }

    if (typeof value === 'object') {
        return Object.entries(value).reduce((acc, [key, val]) => {
            acc[key] = serializeValue(val);
            return acc;
        }, {});
    }

    return value;
}

async function processCommand(options, config, chain) {
    const { wasmPath, contractName } = options;

    const { rpc, networkType } = chain;
    const networkPassphrase = getNetworkPassphrase(networkType);
    const wallet = await getWallet(chain, options);

    if (!chain.contracts) {
        chain.contracts = {};
    }

    const cmd = `soroban contract deploy --wasm ${wasmPath} --source ${options.privateKey} --rpc-url ${rpc} --network-passphrase "${networkPassphrase}"`;
    printInfo('Deploying contract', contractName);

    let contractAddress = options.address;

    if (!contractAddress) {
        contractAddress = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' }).trimEnd();
        printInfo('Deployed contract successfully!', contractAddress);
    } else {
        printInfo('Using existing contract', contractAddress);
    }

    chain.contracts[contractName] = {
        address: contractAddress,
        deployer: wallet.publicKey(),
    };

    if (!options.initialize) {
        return;
    }

    const initializeArgs = await getInitializeArgs(config, chain, contractName, wallet, options);
    const serializedArgs = Object.fromEntries(
        Object.entries(initializeArgs).map(([key, value]) => [key, serializeValue(scValToNative(value))]),
    );
    chain.contracts[contractName].initializeArgs = serializedArgs;

    const contract = new Contract(contractAddress);
    const operation = contract.call('initialize', ...Object.values(initializeArgs));

    printInfo('Initializing contract with args', JSON.stringify(serializedArgs, null, 2));

    await broadcast(operation, wallet, chain, 'Initialized contract', options);

    if (postDeployFunctions[contractName]) {
        await postDeployFunctions[contractName](chain, wallet, options);
        printInfo('Post deployment setup executed');
    }
}

async function mainProcessor(options, processor) {
    const config = loadConfig(options.env);
    await processor(options, config, config.stellar);
    saveConfig(config, options.env);
}

function main() {
    const program = new Command();
    program.name('deploy-contract').description('Deploy Axelar Soroban contracts on Stellar');

    addEnvOption(program);
    program.addOption(new Option('-p, --privateKey <privateKey>', 'private key').env('PRIVATE_KEY'));
    program.addOption(new Option('-v, --verbose', 'verbose output').default(false));
    program.addOption(new Option('--initialize', 'initialize the contract'));
    program.addOption(new Option('--contractName <contractName>', 'contract name to deploy').makeOptionMandatory(true));
    program.addOption(new Option('--wasmPath <wasmPath>', 'path to the WASM file').makeOptionMandatory(true));
    program.addOption(new Option('--address <address>', 'existing instance to initialize'));
    program.addOption(new Option('--estimateCost', 'estimate on-chain resources').default(false));
    program.addOption(new Option('--nonce <nonce>', 'optional nonce for the signer set'));
    program.addOption(
        new Option(
            '--domainSeparator <domainSeparator>',
            'domain separator (pass in the keccak256 hash value OR "offline" meaning that its computed locally)',
        ).default('offline'),
    );

    program.action((options) => {
        mainProcessor(options, processCommand);
    });

    program.parse();
}

if (require.main === module) {
    main();
}
