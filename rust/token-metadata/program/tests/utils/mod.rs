mod assert;
mod edition_marker;
mod external_price;
mod master_edition_v2;
mod metadata;
mod vault;

use std::collections::HashMap;

pub use assert::*;
pub use edition_marker::EditionMarker;
pub use external_price::ExternalPrice;
pub use master_edition_v2::MasterEditionV2;
pub use metadata::Metadata;
use metaplex_token_metadata::processor::process_instruction;
use solana_program::account_info::AccountInfo;
use solana_program_test::*;
use solana_sdk::{
    account::Account, process_instruction::InvokeContext, program_pack::Pack, pubkey::Pubkey,
    signature::Signer, signer::keypair::Keypair, system_instruction, transaction::Transaction,
    transport,
};
use spl_token::state::Mint;
pub use vault::Vault;

pub fn program_test<'a>() -> ProgramTest {
    ProgramTest::new(
        "metaplex_token_metadata",
        metaplex_token_metadata::id(),
        None,
    )
}

pub fn program_test_with_instruction<'a>() -> ProgramTest {
    ProgramTest::new(
        "metaplex_token_metadata",
        metaplex_token_metadata::id(),
        Some(
            |program_id: &Pubkey, input: &[u8], invoke_context: &mut dyn InvokeContext| {
                let accounts: &mut HashMap<Pubkey, Account> = &mut HashMap::new();
                let account_infos: &mut Vec<AccountInfo> = &mut vec![];
                builtin_process_instruction_with_lifetime(
                    process_instruction,
                    program_id,
                    input,
                    invoke_context,
                    accounts,
                    account_infos,
                )
            },
        ),
    )
}

pub async fn get_account(context: &mut ProgramTestContext, pubkey: &Pubkey) -> Account {
    context
        .banks_client
        .get_account(*pubkey)
        .await
        .expect("account not found")
        .expect("account empty")
}

pub async fn get_mint(context: &mut ProgramTestContext, pubkey: &Pubkey) -> Mint {
    let account = get_account(context, pubkey).await;
    Mint::unpack(&account.data).unwrap()
}

pub async fn mint_tokens(
    context: &mut ProgramTestContext,
    mint: &Pubkey,
    account: &Pubkey,
    amount: u64,
    owner: &Pubkey,
    additional_signer: Option<&Keypair>,
) -> transport::Result<()> {
    let mut signing_keypairs = vec![&context.payer];
    if let Some(signer) = additional_signer {
        signing_keypairs.push(signer);
    }

    let tx = Transaction::new_signed_with_payer(
        &[
            // Create Mint Token Instruction with:
            //   * Single authority
            //   0. `[writable]` The mint.
            //   1. `[writable]` The account to mint tokens to.
            //   2. `[signer]` The mint's minting authority.
            // The amount of new tokens to mint.
            spl_token::instruction::mint_to(&spl_token::id(), mint, account, owner, &[], amount)
                .unwrap(),
        ],
        // payer
        Some(&context.payer.pubkey()),
        // signing keypairs
        &signing_keypairs,
        context.last_blockhash,
    );

    context.banks_client.process_transaction(tx).await
}

pub async fn create_token_account(
    context: &mut ProgramTestContext,
    account: &Keypair,
    mint: &Pubkey,
    manager: &Pubkey,
) -> transport::Result<()> {
    let rent = context.banks_client.get_rent().await.unwrap();

    let tx = Transaction::new_signed_with_payer(
        &[
            // Create Token account with:
            //   0. [WRITE, SIGNER] Funding account
            //   1. [WRITE, SIGNER] New account
            // - space+rent:  Token Account state
            // - owned by Token Program
            system_instruction::create_account(
                &context.payer.pubkey(),
                &account.pubkey(),
                rent.minimum_balance(spl_token::state::Account::LEN),
                spl_token::state::Account::LEN as u64,
                &spl_token::id(),
            ),
            // Init account with:
            //   - 0. `[writable]`  The account to initialize.
            //   - 1. `[]` The mint this account will be associated with.
            //   - 2. `[]` The new account's owner/multisignature.
            spl_token::instruction::initialize_account(
                &spl_token::id(),
                &account.pubkey(),
                mint,
                manager,
            )
            .unwrap(),
        ],
        // payer
        Some(&context.payer.pubkey()),
        // signing keypairs
        &[&context.payer, &account],
        context.last_blockhash,
    );

    context.banks_client.process_transaction(tx).await
}

pub async fn create_mint(
    context: &mut ProgramTestContext,
    mint: &Keypair,
    manager: &Pubkey,
    freeze_authority: Option<&Pubkey>,
) -> transport::Result<()> {
    let rent = context.banks_client.get_rent().await.unwrap();

    let tx = Transaction::new_signed_with_payer(
        &[
            // Create token mint account with:
            // - space+rent: Token Mint state
            // - owned by Token Program
            system_instruction::create_account(
                &context.payer.pubkey(),
                &mint.pubkey(),
                rent.minimum_balance(spl_token::state::Mint::LEN),
                spl_token::state::Mint::LEN as u64,
                &spl_token::id(),
            ),
            // Mint token with:
            // - manager as mint authority
            // - freeze authority
            spl_token::instruction::initialize_mint(
                &spl_token::id(),
                &mint.pubkey(),
                &manager,
                freeze_authority,
                0,
            )
            .unwrap(),
        ],
        // payer
        Some(&context.payer.pubkey()),
        // signing keypairs
        &[&context.payer, &mint],
        context.last_blockhash,
    );

    context.banks_client.process_transaction(tx).await
}
