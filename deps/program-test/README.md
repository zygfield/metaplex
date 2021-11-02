# program-test

Slightly modified version of [solana's
program-test](https://github.com/solana-labs/solana/tree/v1.7.11/program-test) which allows to
pass a `process` function that takes lifetime params.

This is necessary to allow running some of our tests like `token-metadata` without `bpf` and
thus allow debugging them.
