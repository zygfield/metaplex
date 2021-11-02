use std::{cell::RefCell, collections::HashMap, intrinsics::transmute, rc::Rc};

use solana_sdk::{
    account::{Account, WritableAccount},
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::InstructionError,
    process_instruction::InvokeContext,
    pubkey::Pubkey,
};

/// Exactly like solana's builtin ProcessInstruction, but her the process function includes
/// parameter lifetimes
pub type CustomProcessInstruction<'a> =
    fn(program_id: &'a Pubkey, accounts: &'a [AccountInfo<'a>], input: &[u8]) -> ProgramResult;

thread_local! {
    static INVOKE_CONTEXT: RefCell<Option<(usize, usize)>> = RefCell::new(None);
}

fn set_invoke_context(new: &mut dyn InvokeContext) {
    INVOKE_CONTEXT.with(|invoke_context| unsafe {
        invoke_context.replace(Some(transmute::<_, (usize, usize)>(new)))
    });
}

/// A version of solana builtin_process_instruction that supports process function with lifetimes
/// Adapted from
/// https://github.com/solana-labs/solana/blob/9ff561134dcee9a6f538dee4a64fc707daabfb15/program-test/src/lib.rs#L102
pub fn custom_builtin_process_instruction<'a>(
    process_instruction: CustomProcessInstruction<'a>,
    program_id: &'a Pubkey,
    input: &[u8],
    invoke_context: &'a mut dyn InvokeContext,
    accounts: &'a mut HashMap<Pubkey, Account>,
    account_infos: &'a mut Vec<AccountInfo<'a>>,
) -> Result<(), InstructionError> {
    set_invoke_context(invoke_context);

    let keyed_accounts = invoke_context.get_keyed_accounts()?;

    // Copy all the accounts into a HashMap to ensure there are no duplicates
    for ka in keyed_accounts {
        accounts.insert(
            *ka.unsigned_key(),
            Account::from(ka.account.borrow().clone()),
        );
    }

    // Create shared references to each account's lamports/data/owner
    let account_refs: HashMap<_, _> = accounts
        .iter_mut()
        .map(|(key, account)| {
            (
                *key,
                (
                    Rc::new(RefCell::new(&mut account.lamports)),
                    Rc::new(RefCell::new(&mut account.data[..])),
                    &account.owner,
                ),
            )
        })
        .collect();

    // Create AccountInfos
    for keyed_account in keyed_accounts {
        let account_info = {
            let key = keyed_account.unsigned_key();
            let (lamports, data, owner) = &account_refs[key];
            AccountInfo {
                key,
                is_signer: keyed_account.signer_key().is_some(),
                is_writable: keyed_account.is_writable(),
                lamports: lamports.clone(),
                data: data.clone(),
                owner,
                executable: keyed_account.executable().unwrap(),
                rent_epoch: keyed_account.rent_epoch().unwrap(),
            }
        };
        account_infos.push(account_info);
    }

    // Execute the program
    process_instruction(program_id, account_infos, input).map_err(u64::from)?;

    // Commit AccountInfo changes back into KeyedAccounts
    for keyed_account in keyed_accounts {
        let mut account = keyed_account.account.borrow_mut();
        let key = keyed_account.unsigned_key();
        let (lamports, data, _owner) = &account_refs[key];
        account.set_lamports(**lamports.borrow());
        account.set_data(data.borrow().to_vec());
    }

    Ok(())
}
