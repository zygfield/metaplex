import { useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';
import {
  CircularProgress,
  Container,
  IconButton,
  Link,
  Slider,
  Snackbar,
} from '@material-ui/core';
import Button from '@material-ui/core/Button';
import Paper from '@material-ui/core/Paper';
import Typography from '@material-ui/core/Typography';
import Grid from '@material-ui/core/Grid';
import { createStyles, Theme } from '@material-ui/core/styles';
import { PhaseCountdown } from './countdown';
import Dialog from '@material-ui/core/Dialog';
import MuiDialogTitle from '@material-ui/core/DialogTitle';
import MuiDialogContent from '@material-ui/core/DialogContent';
import CloseIcon from '@material-ui/icons/Close';

import Alert from '@material-ui/lab/Alert';

import * as anchor from '@project-serum/anchor';

import { LAMPORTS_PER_SOL } from '@solana/web3.js';

import { useWallet } from '@solana/wallet-adapter-react';
import { WalletDialogButton } from '@solana/wallet-adapter-material-ui';

import {
  awaitTransactionSignatureConfirmation,
  CandyMachineAccount,
  getCandyMachineState,
  mintOneToken,
} from './candy-machine';

import {
  FairLaunchAccount,
  getFairLaunchState,
  punchTicket,
  purchaseTicket,
  receiveRefund,
} from './fair-launch';

import { formatNumber, getAtaForMint, toDate } from './utils';
import Countdown from 'react-countdown';

const ConnectButton = styled(WalletDialogButton)`
  width: 100%;
  height: 60px;
  margin-top: 10px;
  margin-bottom: 5px;
  background: linear-gradient(180deg, #604ae5 0%, #813eee 100%);
  color: white;
  font-size: 16px;
  font-weight: bold;
`;

const MintContainer = styled.div``; // add your styles here

const MintButton = styled(Button)`
  width: 100%;
  height: 60px;
  margin-top: 10px;
  margin-bottom: 5px;
  background: linear-gradient(180deg, #604ae5 0%, #813eee 100%);
  color: white;
  font-size: 16px;
  font-weight: bold;
`; // add your styles here

const dialogStyles: any = (theme: Theme) =>
  createStyles({
    root: {
      margin: 0,
      padding: theme.spacing(2),
    },
    closeButton: {
      position: 'absolute',
      right: theme.spacing(1),
      top: theme.spacing(1),
      color: theme.palette.grey[500],
    },
  });

const ValueSlider = styled(Slider)({
  color: '#C0D5FE',
  height: 8,
  '& > *': {
    height: 4,
  },
  '& .MuiSlider-track': {
    border: 'none',
    height: 4,
  },
  '& .MuiSlider-thumb': {
    height: 24,
    width: 24,
    marginTop: -10,
    background: 'linear-gradient(180deg, #604AE5 0%, #813EEE 100%)',
    border: '2px solid currentColor',
    '&:focus, &:hover, &.Mui-active, &.Mui-focusVisible': {
      boxShadow: 'inherit',
    },
    '&:before': {
      display: 'none',
    },
  },
  '& .MuiSlider-valueLabel': {
    '& > *': {
      background: 'linear-gradient(180deg, #604AE5 0%, #813EEE 100%)',
    },
    lineHeight: 1.2,
    fontSize: 12,
    padding: 0,
    width: 32,
    height: 32,
    marginLeft: 9,
  },
});

enum Phase {
  Phase0,
  Phase1,
  Phase2,
  Lottery,
  Phase3,
  Phase4,
  Unknown,
}

const Header = (props: {
  phaseName: string;
  desc: string;
  date: anchor.BN | undefined;
  status?: string;
}) => {
  const { phaseName, desc, date, status } = props;
  return (
    <Grid container justifyContent="center">
      <Grid xs={6} justifyContent="center" direction="column">
        <Typography variant="h5" style={{ fontWeight: 600 }}>
          {phaseName}
        </Typography>
        <Typography variant="body1" color="textSecondary">
          {desc}
        </Typography>
      </Grid>
      <Grid xs={6} container justifyContent="flex-end">
        <PhaseCountdown
          date={toDate(date)}
          style={{ justifyContent: 'flex-end' }}
          status={status || 'COMPLETE'}
        />
      </Grid>
    </Grid>
  );
};

function getPhase(
  fairLaunch: FairLaunchAccount | undefined,
  candyMachine: CandyMachineAccount | undefined,
): Phase {
  const curr = new Date().getTime();

  const phaseOne = toDate(fairLaunch?.state.data.phaseOneStart)?.getTime();
  const phaseOneEnd = toDate(fairLaunch?.state.data.phaseOneEnd)?.getTime();
  const phaseTwoEnd = toDate(fairLaunch?.state.data.phaseTwoEnd)?.getTime();
  const candyMachineGoLive = toDate(candyMachine?.state.goLiveDate)?.getTime();

  if (phaseOne && curr < phaseOne) {
    return Phase.Phase0;
  } else if (phaseOneEnd && curr <= phaseOneEnd) {
    return Phase.Phase1;
  } else if (phaseTwoEnd && curr <= phaseTwoEnd) {
    return Phase.Phase2;
  } else if (!fairLaunch?.state.phaseThreeStarted) {
    return Phase.Lottery;
  } else if (
    fairLaunch?.state.phaseThreeStarted &&
    candyMachineGoLive &&
    curr > candyMachineGoLive
  ) {
    return Phase.Phase4;
  } else if (fairLaunch?.state.phaseThreeStarted) {
    return Phase.Phase3;
  }

  return Phase.Unknown;
}

export interface HomeProps {
  candyMachineId?: anchor.web3.PublicKey;
  fairLaunchId: anchor.web3.PublicKey;
  connection: anchor.web3.Connection;
  startDate: number;
  txTimeout: number;
}

const FAIR_LAUNCH_LOTTERY_SIZE =
  8 + // discriminator
  32 + // fair launch
  1 + // bump
  8; // size of bitmask ones

const isWinner = (
  fairLaunch: FairLaunchAccount | undefined,
  fairLaunchBalance: number,
): boolean => {
  if (fairLaunchBalance > 0) return true;
  if (
    !fairLaunch?.lottery.data ||
    !fairLaunch?.lottery.data.length ||
    !fairLaunch?.ticket.data?.seq ||
    !fairLaunch?.state.phaseThreeStarted
  ) {
    return false;
  }

  const myByte =
    fairLaunch.lottery.data[
      FAIR_LAUNCH_LOTTERY_SIZE +
        Math.floor(fairLaunch.ticket.data?.seq.toNumber() / 8)
    ];

  const positionFromRight = 7 - (fairLaunch.ticket.data?.seq.toNumber() % 8);
  const mask = Math.pow(2, positionFromRight);
  const isWinner = myByte & mask;
  return isWinner > 0;
};

const Home = (props: HomeProps) => {
  const [fairLaunchBalance, setFairLaunchBalance] = useState<number>(0);
  const [yourSOLBalance, setYourSOLBalance] = useState<number | null>(null);

  const [isMinting, setIsMinting] = useState(false); // true when user got to press MINT
  const [contributed, setContributed] = useState(0);

  const wallet = useWallet();

  const anchorWallet = useMemo(() => {
    if (
      !wallet ||
      !wallet.publicKey ||
      !wallet.signAllTransactions ||
      !wallet.signTransaction
    ) {
      return;
    }

    return {
      publicKey: wallet.publicKey,
      signAllTransactions: wallet.signAllTransactions,
      signTransaction: wallet.signTransaction,
    } as anchor.Wallet;
  }, [wallet]);

  const [alertState, setAlertState] = useState<AlertState>({
    open: false,
    message: '',
    severity: undefined,
  });

  const [fairLaunch, setFairLaunch] = useState<FairLaunchAccount>();
  const [candyMachine, setCandyMachine] = useState<CandyMachineAccount>();
  const [howToOpen, setHowToOpen] = useState(false);
  const [refundExplainerOpen, setRefundExplainerOpen] = useState(false);
  const [antiRugPolicyOpen, setAnitRugPolicyOpen] = useState(false);

  const onMint = async () => {
    try {
      setIsMinting(true);
      if (wallet.connected && candyMachine?.program && wallet.publicKey) {
        if (
          fairLaunch?.ticket.data?.state.unpunched &&
          isWinner(fairLaunch, fairLaunchBalance)
        ) {
          await onPunchTicket();
        }

        const mintTxId = await mintOneToken(candyMachine, wallet.publicKey);

        const status = await awaitTransactionSignatureConfirmation(
          mintTxId,
          props.txTimeout,
          props.connection,
          'singleGossip',
          false,
        );

        if (!status?.err) {
          setAlertState({
            open: true,
            message: 'Congratulations! Mint succeeded!',
            severity: 'success',
          });
        } else {
          setAlertState({
            open: true,
            message: 'Mint failed! Please try again!',
            severity: 'error',
          });
        }
      }
    } catch (error: any) {
      // TODO: blech:
      let message = error.msg || 'Minting failed! Please try again!';
      if (!error.msg) {
        if (!error.message) {
          message = 'Transaction Timeout! Please try again.';
        } else if (error.message.indexOf('0x138')) {
        } else if (error.message.indexOf('0x137')) {
          message = `SOLD OUT!`;
        } else if (error.message.indexOf('0x135')) {
          message = `Insufficient funds to mint. Please fund your wallet.`;
        }
      } else {
        if (error.code === 311) {
          message = `SOLD OUT!`;
          window.location.reload();
        } else if (error.code === 312) {
          message = `Minting period hasn't started yet.`;
        }
      }

      setAlertState({
        open: true,
        message,
        severity: 'error',
      });
    } finally {
      setIsMinting(false);
    }
  };

  useEffect(() => {
    (async () => {
      if (!anchorWallet) {
        return;
      }

      try {
        const balance = await props.connection.getBalance(
          anchorWallet.publicKey,
        );
        setYourSOLBalance(balance);

        const state = await getFairLaunchState(
          anchorWallet,
          props.fairLaunchId,
          props.connection,
        );

        setFairLaunch(state);

        try {
          if (state.state.tokenMint) {
            const fairLaunchBalance =
              await props.connection.getTokenAccountBalance(
                (
                  await getAtaForMint(
                    state.state.tokenMint,
                    anchorWallet.publicKey,
                  )
                )[0],
              );

            if (fairLaunchBalance.value) {
              setFairLaunchBalance(fairLaunchBalance.value.uiAmount || 0);
            }
          }
        } catch (e) {
          console.log('Problem getting fair launch token balance');
          console.log(e);
        }
        setContributed(
          (
            state.state.currentMedian || state.state.data.priceRangeStart
          ).toNumber() / LAMPORTS_PER_SOL,
        );
      } catch (e) {
        console.log('Problem getting fair launch state');
        console.log(e);
      }
      if (props.candyMachineId) {
        try {
          const cndy = await getCandyMachineState(
            anchorWallet,
            props.candyMachineId,
            props.connection,
          );
          setCandyMachine(cndy);
        } catch (e) {
          console.log('Problem getting candy machine state');
          console.log(e);
        }
      } else {
        console.log('No candy machine detected in configuration.');
      }
    })();
  }, [
    anchorWallet,
    props.candyMachineId,
    props.connection,
    props.fairLaunchId,
  ]);

  const min = formatNumber.asNumber(fairLaunch?.state.data.priceRangeStart);
  const max = formatNumber.asNumber(fairLaunch?.state.data.priceRangeEnd);
  const step = formatNumber.asNumber(fairLaunch?.state.data.tickSize);
  const median = formatNumber.asNumber(fairLaunch?.state.currentMedian);
  const marks = [
    {
      value: min || 0,
      label: `${min} SOL`,
    },
    // TODO:L
    {
      value: median || 0,
      label: `${median}`,
    },
    // display user comitted value
    // {
    //   value: 37,
    //   label: '37°C',
    // },
    {
      value: max || 0,
      label: `${max} SOL`,
    },
  ].filter(_ => _ !== undefined && _.value !== 0) as any;

  const onDeposit = async () => {
    if (!anchorWallet) {
      return;
    }

    console.log('deposit');
    setIsMinting(true);
    try {
      await purchaseTicket(contributed, anchorWallet, fairLaunch);
      setIsMinting(false);
      setAlertState({
        open: true,
        message: `Congratulations! Bid ${
          fairLaunch?.ticket.data ? 'updated' : 'inserted'
        }!`,
        severity: 'success',
      });
    } catch (e) {
      console.log(e);
      setIsMinting(false);
      setAlertState({
        open: true,
        message: 'Something went wrong.',
        severity: 'error',
      });
    }
  };
  const onRugRefund = async () => {
    if (!anchorWallet) {
      return;
    }

    console.log('refund');
    try {
      setIsMinting(true);
      await receiveRefund(anchorWallet, fairLaunch);
      setIsMinting(false);
      setAlertState({
        open: true,
        message:
          'Congratulations! You have received a refund. This is an irreversible action.',
        severity: 'success',
      });
    } catch (e) {
      console.log(e);
      setIsMinting(false);
      setAlertState({
        open: true,
        message: 'Something went wrong.',
        severity: 'error',
      });
    }
  };
  const onRefundTicket = async () => {
    if (!anchorWallet) {
      return;
    }

    console.log('refund');
    try {
      setIsMinting(true);
      await purchaseTicket(0, anchorWallet, fairLaunch);
      setIsMinting(false);
      setAlertState({
        open: true,
        message:
          'Congratulations! Funds withdrawn. This is an irreversible action.',
        severity: 'success',
      });
    } catch (e) {
      console.log(e);
      setIsMinting(false);
      setAlertState({
        open: true,
        message: 'Something went wrong.',
        severity: 'error',
      });
    }
  };

  const onPunchTicket = async () => {
    if (!anchorWallet || !fairLaunch || !fairLaunch.ticket) {
      return;
    }

    console.log('punch');
    setIsMinting(true);
    try {
      await punchTicket(anchorWallet, fairLaunch);
      setIsMinting(false);
      setAlertState({
        open: true,
        message: 'Congratulations! Ticket punched!',
        severity: 'success',
      });
    } catch (e) {
      console.log(e);
      setIsMinting(false);
      setAlertState({
        open: true,
        message: 'Something went wrong.',
        severity: 'error',
      });
    }
  };

  const phase = getPhase(fairLaunch, candyMachine);

  const candyMachinePredatesFairLaunch =
    candyMachine?.state.goLiveDate &&
    fairLaunch?.state.data.phaseTwoEnd &&
    candyMachine?.state.goLiveDate.lt(fairLaunch?.state.data.phaseTwoEnd);

  const notEnoughSOL = !!(
    yourSOLBalance != null &&
    fairLaunch?.state.data.priceRangeStart &&
    fairLaunch?.state.data.fee &&
    yourSOLBalance + (fairLaunch?.ticket?.data?.amount.toNumber() || 0) <
      contributed * LAMPORTS_PER_SOL +
        fairLaunch?.state.data.fee.toNumber() +
        0.01
  );

  return (
    <Container style={{ marginTop: 50 }}>
      <div className="header">
        <svg viewBox="0 0 1401 253" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M484.412 215.353V211.588H480.647V207.824H446.765V211.588H454.294V215.353H450.529V219.118H446.765V211.588H443V249.235H446.765V253H461.824V249.235H465.588V237.941H480.647V234.176H484.412V230.412H488.176V215.353H484.412ZM465.588 219.118H473.118V230.412H465.588V219.118ZM537.099 215.353V211.588H533.335V207.824H499.452V211.588H506.982V215.353H503.217V219.118H499.452V211.588H495.688V249.235H499.452V253H514.511V249.235H518.276V237.941H533.335V234.176H537.099V230.412H540.864V215.353H537.099ZM518.276 219.118H525.805V230.412H518.276V219.118ZM586.022 237.941H570.963V211.588H567.199V207.824H552.14V211.588H559.669V215.353H555.904V219.118H552.14V211.588H548.375V249.235H552.14V253H586.022V249.235H589.787V241.706H586.022V237.941ZM638.724 215.353V211.588H634.96V207.824H601.077V211.588H608.607V215.353H604.842V219.118H601.077V211.588H597.312V249.235H601.077V253H616.136V249.235H619.901V237.941H634.96V234.176H638.724V230.412H642.489V215.353H638.724ZM619.901 219.118H627.43V230.412H619.901V219.118ZM687.647 237.941H672.588V211.588H668.824V207.824H653.765V211.588H661.294V215.353H657.529V219.118H653.765V211.588H650V249.235H653.765V253H687.647V249.235H691.412V241.706H687.647V237.941ZM740.349 207.824H702.702V211.588H710.232V215.353H706.467V219.118H702.702V211.588H698.938V249.235H702.702V253H740.349V249.235H744.114V241.706H740.349V237.941H721.526V234.176H740.349V230.412H744.114V226.647H740.349V222.882H721.526V219.118H740.349V215.353H744.114V211.588H740.349V207.824ZM793.037 211.588H789.272V207.824H759.154V211.588H762.919V215.353H759.154V219.118H755.39V215.353H751.625V249.235H755.39V253H770.449V249.235H774.213V234.176H785.507V249.235H789.272V253H793.037V249.235H796.801V215.353H793.037V211.588ZM785.507 222.882H774.213V219.118H785.507V222.882ZM845.724 207.824H811.842V211.588H815.607V215.353H811.842V219.118H808.077V215.353H804.312V226.647H808.077V230.412H834.43V234.176H808.077V237.941H804.312V249.235H808.077V253H841.96V249.235H845.724V245.471H849.489V226.647H845.724V222.882H826.901V219.118H845.724V215.353H849.489V211.588H845.724V207.824ZM898.412 207.824H860.765V211.588H868.294V215.353H864.529V219.118H860.765V211.588H857V249.235H860.765V253H898.412V249.235H902.176V241.706H898.412V237.941H879.588V234.176H898.412V230.412H902.176V226.647H898.412V222.882H879.588V219.118H898.412V215.353H902.176V211.588H898.412V207.824ZM951.099 211.588H947.335V207.824H913.452V211.588H920.982V215.353H917.217V219.118H913.452V211.588H909.688V249.235H913.452V253H928.511V249.235H932.276V237.941H936.04V241.706H939.805V245.471H943.57V249.235H947.335V253H951.099V249.235H954.864V237.941H951.099V234.176H947.335V230.412H951.099V226.647H954.864V215.353H951.099V211.588ZM932.276 222.882V219.118H943.57V222.882H932.276Z" fill="#E3E4D3"/>
          <path d="M80.4267 67.4706H14.7796V74.7647H22.0738V82.0588H14.7796V89.3529H7.48552V82.0588H0.191406V140.412H7.48552V147.706H14.7796V155H80.4267V147.706H87.7208V133.118H80.4267V125.824H43.9561V89.3529H80.4267V82.0588H87.7208V74.7647H80.4267V67.4706ZM182.509 74.7647H175.215V67.4706H116.862V74.7647H124.156V82.0588H116.862V89.3529H109.568V82.0588H102.273V140.412H109.568V147.706H116.862V155H175.215V147.706H182.509V140.412H189.803V82.0588H182.509V74.7647ZM167.92 125.824H146.038V89.3529H167.92V125.824ZM277.297 125.824H248.12V74.7647H240.826V67.4706H211.65V74.7647H226.238V82.0588H218.944V89.3529H211.65V74.7647H204.355V147.706H211.65V155H277.297V147.706H284.591V133.118H277.297V125.824ZM372.113 125.824H342.937V74.7647H335.642V67.4706H306.466V74.7647H321.054V82.0588H313.76V89.3529H306.466V74.7647H299.172V147.706H306.466V155H372.113V147.706H379.407V133.118H372.113V125.824ZM474.224 67.4706H401.282V74.7647H415.871V82.0588H408.577V89.3529H401.282V74.7647H393.988V147.706H401.282V155H474.224V147.706H481.518V133.118H474.224V125.824H437.753V118.529H474.224V111.235H481.518V103.941H474.224V96.6471H437.753V89.3529H474.224V82.0588H481.518V74.7647H474.224V67.4706ZM576.306 67.4706H510.659V74.7647H517.953V82.0588H510.659V89.3529H503.364V82.0588H496.07V140.412H503.364V147.706H510.659V155H576.306V147.706H583.6V133.118H576.306V125.824H539.835V89.3529H576.306V82.0588H583.6V74.7647H576.306V67.4706ZM678.388 67.4706H605.446V74.7647H620.035V82.0588H612.741V89.3529H605.446V96.6471H620.035V147.706H627.329V155H656.505V147.706H663.799V96.6471H678.388V89.3529H685.682V74.7647H678.388V67.4706ZM605.446 74.7647H598.152V89.3529H605.446V74.7647ZM780.47 74.7647H773.176V67.4706H714.823V74.7647H722.117V82.0588H714.823V89.3529H707.528V82.0588H700.234V140.412H707.528V147.706H714.823V155H773.176V147.706H780.47V140.412H787.764V82.0588H780.47V74.7647ZM765.881 125.824H743.999V89.3529H765.881V125.824ZM882.552 74.7647H875.258V67.4706H816.905V74.7647H824.199V82.0588H816.905V89.3529H809.611V82.0588H802.316V140.412H809.611V147.706H816.905V155H875.258V147.706H882.552V140.412H889.846V82.0588H882.552V74.7647ZM867.963 125.824H846.081V89.3529H867.963V125.824ZM984.634 74.7647H977.34V67.4706H918.987V74.7647H926.281V82.0588H918.987V89.3529H911.693V82.0588H904.398V140.412H911.693V147.706H918.987V155H977.34V147.706H984.634V140.412H991.928V82.0588H984.634V74.7647ZM970.045 125.824H948.163V89.3529H970.045V125.824ZM1086.72 74.7647H1079.42V67.4706H1021.07V74.7647H1028.36V82.0588H1021.07V89.3529H1013.77V82.0588H1006.48V140.412H1013.77V147.706H1021.07V155H1079.42V147.706H1086.72V140.412H1094.01V82.0588H1086.72V74.7647ZM1072.13 125.824H1050.25V89.3529H1072.13V125.824ZM1188.8 74.7647H1181.5V67.4706H1123.15V74.7647H1130.44V82.0588H1123.15V89.3529H1115.86V82.0588H1108.56V140.412H1115.86V147.706H1123.15V155H1181.5V147.706H1188.8V140.412H1196.09V82.0588H1188.8V74.7647ZM1174.21 125.824H1152.33V89.3529H1174.21V125.824ZM1290.88 74.7647H1283.59V67.4706H1225.23V74.7647H1232.53V82.0588H1225.23V89.3529H1217.94V82.0588H1210.64V140.412H1217.94V147.706H1225.23V155H1283.59V147.706H1290.88V140.412H1298.17V82.0588H1290.88V74.7647ZM1276.29 125.824H1254.41V89.3529H1276.29V125.824ZM1392.96 74.7647H1385.67V67.4706H1320.02V74.7647H1334.61V82.0588H1327.31V89.3529H1320.02V74.7647H1312.73V147.706H1320.02V155H1349.2V147.706H1356.49V125.824H1363.79V133.118H1371.08V140.412H1378.37V147.706H1385.67V155H1392.96V147.706H1400.26V125.824H1392.96V118.529H1385.67V111.235H1392.96V103.941H1400.26V82.0588H1392.96V74.7647ZM1356.49 96.6471V89.3529H1378.37V96.6471H1356.49Z" fill="#E3E4D3"/>
          <path d="M665.412 0.823528H627.765V4.58823H635.294V8.35294H631.529V12.1176H627.765V15.8824H635.294V42.2353H639.059V46H654.118V42.2353H657.882V15.8824H665.412V12.1176H669.176V4.58823H665.412V0.823528ZM627.765 4.58823H624V12.1176H627.765V4.58823ZM718.099 4.58823V0.823528H710.57V4.58823H706.805V15.8824H699.276V4.58823H695.511V0.823528H680.452V4.58823H687.982V8.35294H684.217V12.1176H680.452V4.58823H676.688V42.2353H680.452V46H695.511V42.2353H699.276V27.1765H706.805V42.2353H710.57V46H718.099V42.2353H721.864V4.58823H718.099ZM770.787 0.823528H733.14V4.58823H740.669V8.35294H736.904V12.1176H733.14V4.58823H729.375V42.2353H733.14V46H770.787V42.2353H774.551V34.7059H770.787V30.9412H751.963V27.1765H770.787V23.4118H774.551V19.6471H770.787V15.8824H751.963V12.1176H770.787V8.35294H774.551V4.58823H770.787V0.823528Z" fill="#E3E4D3"/>
        </svg>
        <span>in collaboration with Cloud Eater Studios</span>
      </div>
      <div className="main" >
        <div className="left" style={{ position: 'relative' }}>
          <Container maxWidth="xs" style={{ position: 'relative' }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                justifyContent: 'flex-end',
              }}
            >
              <Link
                component="button"
                variant="body2"
                color="textSecondary"
                align="right"
                onClick={() => {
                  setAnitRugPolicyOpen(true);
                }}
              >
                Anti-Rug Policy
              </Link>
            </div>
          </Container>
          <Container maxWidth="xs" style={{ position: 'relative' }}>
            <Paper
              style={{ padding: 24, backgroundColor: '#151A1F', borderRadius: 6 }}
            >
              <Grid container justifyContent="center" direction="column">
                {phase === Phase.Phase0 && (
                  <Header
                    phaseName={'Phase 0'}
                    desc={'Anticipation Phase'}
                    date={fairLaunch?.state.data.phaseOneStart}
                  />
                )}
                {phase === Phase.Phase1 && (
                  <Header
                    phaseName={'Phase 1'}
                    desc={'Set price phase'}
                    date={fairLaunch?.state.data.phaseOneEnd}
                  />
                )}

                {phase === Phase.Phase2 && (
                  <Header
                    phaseName={'Phase 2'}
                    desc={'Grace period'}
                    date={fairLaunch?.state.data.phaseTwoEnd}
                  />
                )}

                {phase === Phase.Lottery && (
                  <Header
                    phaseName={'Phase 3'}
                    desc={'Raffle in progress'}
                    date={fairLaunch?.state.data.phaseTwoEnd.add(
                      fairLaunch?.state.data.lotteryDuration,
                    )}
                  />
                )}

                {phase === Phase.Phase3 && !candyMachine && (
                  <Header
                    phaseName={'Phase 3'}
                    desc={'Raffle finished!'}
                    date={fairLaunch?.state.data.phaseTwoEnd}
                  />
                )}

                {phase === Phase.Phase3 && candyMachine && (
                  <Header
                    phaseName={'Phase 3'}
                    desc={'Minting starts in...'}
                    date={candyMachine?.state.goLiveDate}
                  />
                )}

                {phase === Phase.Phase4 && (
                  <Header
                    phaseName={
                      candyMachinePredatesFairLaunch ? 'Phase 3' : 'Phase 4'
                    }
                    desc={'Candy Time 🍬 🍬 🍬'}
                    date={candyMachine?.state.goLiveDate}
                    status="LIVE"
                  />
                )}

                {fairLaunch && (
                  <Grid
                    container
                    direction="column"
                    justifyContent="center"
                    alignItems="center"
                    style={{
                      height: 200,
                      marginTop: 20,
                      marginBottom: 20,
                      background: '#384457',
                      borderRadius: 6,
                    }}
                  >
                    {fairLaunch.ticket.data ? (
                      <>
                        <Typography>Your bid</Typography>
                        <Typography variant="h6" style={{ fontWeight: 900 }}>
                          {formatNumber.format(
                            (fairLaunch?.ticket.data?.amount.toNumber() || 0) /
                              LAMPORTS_PER_SOL,
                          )}{' '}
                          SOL
                        </Typography>
                      </>
                    ) : [Phase.Phase0, Phase.Phase1].includes(phase) ? (
                      <Typography>
                        You haven't entered this raffle yet. <br />
                        {fairLaunch?.state?.data?.fee && (
                          <span>
                            <b>
                              All initial bids will incur a ◎{' '}
                              {fairLaunch?.state?.data?.fee.toNumber() /
                                LAMPORTS_PER_SOL}{' '}
                              fee.
                            </b>
                          </span>
                        )}
                      </Typography>
                    ) : (
                      <Typography>
                        You didn't participate in this raffle.
                      </Typography>
                    )}
                  </Grid>
                )}

                {fairLaunch && (
                  <>
                    {[
                      Phase.Phase1,
                      Phase.Phase2,
                      Phase.Phase3,
                      Phase.Lottery,
                    ].includes(phase) &&
                      fairLaunch?.ticket?.data?.state.withdrawn && (
                        <div style={{ paddingTop: '15px' }}>
                          <Alert severity="error">
                            Your bid was withdrawn and cannot be adjusted or
                            re-inserted.
                          </Alert>
                        </div>
                      )}
                    {[Phase.Phase1, Phase.Phase2].includes(phase) &&
                      fairLaunch.state.currentMedian &&
                      fairLaunch?.ticket?.data?.amount &&
                      !fairLaunch?.ticket?.data?.state.withdrawn &&
                      fairLaunch.state.currentMedian.gt(
                        fairLaunch?.ticket?.data?.amount,
                      ) && (
                        <div style={{ paddingTop: '15px' }}>
                          <Alert severity="warning">
                            Your bid is currently below the median and will not be
                            eligible for the raffle.
                          </Alert>
                        </div>
                      )}
                    {[Phase.Phase3, Phase.Lottery].includes(phase) &&
                      fairLaunch.state.currentMedian &&
                      fairLaunch?.ticket?.data?.amount &&
                      !fairLaunch?.ticket?.data?.state.withdrawn &&
                      fairLaunch.state.currentMedian.gt(
                        fairLaunch?.ticket?.data?.amount,
                      ) && (
                        <div style={{ paddingTop: '15px' }}>
                          <Alert severity="error">
                            Your bid was below the median and was not included in
                            the raffle. You may click <em>Withdraw</em> when the
                            raffle ends or you will be automatically issued one when
                            the Fair Launch authority withdraws from the treasury.
                          </Alert>
                        </div>
                      )}
                    {notEnoughSOL && (
                      <Alert severity="error">
                        You do not have enough SOL in your account to place this
                        bid.
                      </Alert>
                    )}
                  </>
                )}

                {[Phase.Phase1, Phase.Phase2].includes(phase) && (
                  <>
                    <Grid style={{ marginTop: 40, marginBottom: 20 }}>
                      <ValueSlider
                        min={min}
                        marks={marks}
                        max={max}
                        step={step}
                        value={contributed}
                        onChange={(ev, val) => setContributed(val as any)}
                        valueLabelDisplay="auto"
                        style={{
                          width: 'calc(100% - 40px)',
                          marginLeft: 20,
                          height: 30,
                        }}
                      />
                    </Grid>
                  </>
                )}

                {!wallet.connected ? (
                  <ConnectButton>
                    Connect{' '}
                    {[Phase.Phase1].includes(phase) ? 'to bid' : 'to see status'}
                  </ConnectButton>
                ) : (
                  <div>
                    {[Phase.Phase1, Phase.Phase2].includes(phase) && (
                      <>
                        <MintButton
                          onClick={onDeposit}
                          variant="contained"
                          disabled={
                            isMinting ||
                            (!fairLaunch?.ticket.data && phase === Phase.Phase2) ||
                            notEnoughSOL
                          }
                        >
                          {isMinting ? (
                            <CircularProgress />
                          ) : !fairLaunch?.ticket.data ? (
                            'Place bid'
                          ) : (
                            'Change bid'
                          )}
                          {}
                        </MintButton>
                      </>
                    )}

                    {[Phase.Phase3].includes(phase) && (
                      <>
                        {isWinner(fairLaunch, fairLaunchBalance) && (
                          <MintButton
                            onClick={onPunchTicket}
                            variant="contained"
                            disabled={
                              fairLaunch?.ticket.data?.state.punched !== undefined
                            }
                          >
                            {isMinting ? <CircularProgress /> : 'Punch Ticket'}
                          </MintButton>
                        )}

                        {!isWinner(fairLaunch, fairLaunchBalance) && (
                          <MintButton
                            onClick={onRefundTicket}
                            variant="contained"
                            disabled={
                              isMinting ||
                              fairLaunch?.ticket.data === undefined ||
                              fairLaunch?.ticket.data?.state.withdrawn !== undefined
                            }
                          >
                            {isMinting ? <CircularProgress /> : 'Withdraw'}
                          </MintButton>
                        )}
                      </>
                    )}

                    {phase === Phase.Phase4 && (
                      <>
                        {(!fairLaunch ||
                          isWinner(fairLaunch, fairLaunchBalance)) && (
                          <MintContainer>
                            <MintButton
                              disabled={
                                candyMachine?.state.isSoldOut ||
                                isMinting ||
                                !candyMachine?.state.isActive ||
                                (fairLaunch?.ticket?.data?.state.punched &&
                                  fairLaunchBalance === 0)
                              }
                              onClick={onMint}
                              variant="contained"
                            >
                              {fairLaunch?.ticket?.data?.state.punched &&
                              fairLaunchBalance === 0 ? (
                                'MINTED'
                              ) : candyMachine?.state.isSoldOut ? (
                                'SOLD OUT'
                              ) : isMinting ? (
                                <CircularProgress />
                              ) : (
                                'MINT'
                              )}
                            </MintButton>
                          </MintContainer>
                        )}

                        {!isWinner(fairLaunch, fairLaunchBalance) && (
                          <MintButton
                            onClick={onRefundTicket}
                            variant="contained"
                            disabled={
                              isMinting ||
                              fairLaunch?.ticket.data === undefined ||
                              fairLaunch?.ticket.data?.state.withdrawn !== undefined
                            }
                          >
                            {isMinting ? <CircularProgress /> : 'Withdraw'}
                          </MintButton>
                        )}
                      </>
                    )}
                  </div>
                )}

                <Grid
                  container
                  justifyContent="space-between"
                  color="textSecondary"
                >
                  <Link
                    component="button"
                    variant="body2"
                    color="textSecondary"
                    align="left"
                    onClick={() => {
                      setHowToOpen(true);
                    }}
                  >
                    How this raffle works
                  </Link>
                  {fairLaunch?.ticket.data && (
                    <Link
                      component="button"
                      variant="body2"
                      color="textSecondary"
                      align="right"
                      onClick={() => {
                        if (
                          !fairLaunch ||
                          phase === Phase.Lottery ||
                          isWinner(fairLaunch, fairLaunchBalance)
                        ) {
                          setRefundExplainerOpen(true);
                        } else {
                          onRefundTicket();
                        }
                      }}
                    >
                      Withdraw funds
                    </Link>
                  )}
                </Grid>
                <Dialog
                  open={refundExplainerOpen}
                  onClose={() => setRefundExplainerOpen(false)}
                  PaperProps={{
                    style: { backgroundColor: '#222933', borderRadius: 6 },
                  }}
                >
                  <MuiDialogContent style={{ padding: 24 }}>
                    During raffle phases, or if you are a winner, or if this website
                    is not configured to be a fair launch but simply a candy
                    machine, refunds are disallowed.
                  </MuiDialogContent>
                </Dialog>
                <Dialog
                  open={antiRugPolicyOpen}
                  onClose={() => {
                    setAnitRugPolicyOpen(false);
                  }}
                  PaperProps={{
                    style: { backgroundColor: '#222933', borderRadius: 6 },
                  }}
                >
                  <MuiDialogContent style={{ padding: 24 }}>
                    {!fairLaunch?.state.data.antiRugSetting && (
                      <span>This Fair Launch has no anti-rug settings.</span>
                    )}
                    {fairLaunch?.state.data.antiRugSetting &&
                      fairLaunch.state.data.antiRugSetting.selfDestructDate && (
                        <div>
                          <h3>Anti-Rug Policy</h3>
                          <p>
                            This raffle is governed by a smart contract to prevent
                            the artist from running away with your money.
                          </p>
                          <p>How it works:</p>
                          This project will retain{' '}
                          {fairLaunch.state.data.antiRugSetting.reserveBp / 100}% (◎{' '}
                          {(fairLaunch?.treasury *
                            fairLaunch.state.data.antiRugSetting.reserveBp) /
                            (LAMPORTS_PER_SOL * 10000)}
                          ) of the pledged amount in a locked state until all but{' '}
                          {fairLaunch.state.data.antiRugSetting.tokenRequirement.toNumber()}{' '}
                          NFTs (out of up to{' '}
                          {fairLaunch.state.data.numberOfTokens.toNumber()}) have
                          been minted.
                          <p>
                            If more than{' '}
                            {fairLaunch.state.data.antiRugSetting.tokenRequirement.toNumber()}{' '}
                            NFTs remain as of{' '}
                            {toDate(
                              fairLaunch.state.data.antiRugSetting.selfDestructDate,
                            )?.toLocaleDateString()}{' '}
                            at{' '}
                            {toDate(
                              fairLaunch.state.data.antiRugSetting.selfDestructDate,
                            )?.toLocaleTimeString()}
                            , you will have the option to get a refund of{' '}
                            {fairLaunch.state.data.antiRugSetting.reserveBp / 100}%
                            of the cost of your token.
                          </p>
                          {fairLaunch?.ticket?.data &&
                            !fairLaunch?.ticket?.data.state.withdrawn && (
                              <MintButton
                                onClick={onRugRefund}
                                variant="contained"
                                disabled={
                                  !!!fairLaunch.ticket.data ||
                                  !fairLaunch.ticket.data.state.punched ||
                                  Date.now() / 1000 <
                                    fairLaunch.state.data.antiRugSetting.selfDestructDate.toNumber()
                                }
                              >
                                {isMinting ? (
                                  <CircularProgress />
                                ) : Date.now() / 1000 <
                                  fairLaunch.state.data.antiRugSetting.selfDestructDate.toNumber() ? (
                                  <span>
                                    Refund in...
                                    <Countdown
                                      date={toDate(
                                        fairLaunch.state.data.antiRugSetting
                                          .selfDestructDate,
                                      )}
                                    />
                                  </span>
                                ) : (
                                  'Refund'
                                )}
                                {}
                              </MintButton>
                            )}
                          <div style={{ textAlign: 'center', marginTop: '-5px' }}>
                            {fairLaunch?.ticket?.data &&
                              !fairLaunch?.ticket?.data?.state.punched && (
                                <small>
                                  You currently have a ticket but it has not been
                                  punched yet, so cannot be refunded.
                                </small>
                              )}
                          </div>
                        </div>
                      )}
                  </MuiDialogContent>
                </Dialog>
                <Dialog
                  open={howToOpen}
                  onClose={() => setHowToOpen(false)}
                  PaperProps={{
                    style: { backgroundColor: '#222933', borderRadius: 6 },
                  }}
                >
                  <MuiDialogTitle
                    disableTypography
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Link
                      component="button"
                      variant="h6"
                      color="textSecondary"
                      onClick={() => {
                        setHowToOpen(true);
                      }}
                    >
                      How it works
                    </Link>
                    <IconButton
                      aria-label="close"
                      className={dialogStyles.closeButton}
                      onClick={() => setHowToOpen(false)}
                    >
                      <CloseIcon />
                    </IconButton>
                  </MuiDialogTitle>
                  <MuiDialogContent>
                    <Typography variant="h6">
                      Phase 1 - Set the fair price:
                    </Typography>
                    <Typography gutterBottom color="textSecondary">
                      Enter a bid in the range provided by the artist. The median of
                      all bids will be the "fair" price of the raffle ticket.{' '}
                      {fairLaunch?.state?.data?.fee && (
                        <span>
                          <b>
                            All bids will incur a ◎{' '}
                            {fairLaunch?.state?.data?.fee.toNumber() /
                              LAMPORTS_PER_SOL}{' '}
                            fee.
                          </b>
                        </span>
                      )}
                    </Typography>
                    <Typography variant="h6">Phase 2 - Grace period:</Typography>
                    <Typography gutterBottom color="textSecondary">
                      If your bid was at or above the fair price, you automatically
                      get a raffle ticket at that price. There's nothing else you
                      need to do. Your excess SOL will be returned to you when the
                      Fair Launch authority withdraws from the treasury. If your bid
                      is below the median price, you can still opt in at the fair
                      price during this phase.
                    </Typography>
                    {candyMachinePredatesFairLaunch ? (
                      <>
                        <Typography variant="h6">
                          Phase 3 - The Candy Machine:
                        </Typography>
                        <Typography gutterBottom color="textSecondary">
                          Everyone who got a raffle ticket at the fair price is
                          entered to win an NFT. If you win an NFT, congrats. If you
                          don’t, no worries, your SOL will go right back into your
                          wallet.
                        </Typography>
                      </>
                    ) : (
                      <>
                        <Typography variant="h6">Phase 3 - The Lottery:</Typography>
                        <Typography gutterBottom color="textSecondary">
                          Everyone who got a raffle ticket at the fair price is
                          entered to win a Fair Launch Token that entitles them to
                          an NFT at a later date using a Candy Machine here. If you
                          don’t win, no worries, your SOL will go right back into
                          your wallet.
                        </Typography>
                        <Typography variant="h6">
                          Phase 4 - The Candy Machine:
                        </Typography>
                        <Typography gutterBottom color="textSecondary">
                          On{' '}
                          {candyMachine?.state.goLiveDate
                            ? toDate(
                                candyMachine?.state.goLiveDate,
                              )?.toLocaleString()
                            : ' some later date'}
                          , you will be able to exchange your Fair Launch token for
                          an NFT using the Candy Machine at this site by pressing
                          the Mint Button.
                        </Typography>
                      </>
                    )}
                  </MuiDialogContent>
                </Dialog>

                {/* {wallet.connected && (
                  <p>
                    Address: {shortenAddress(wallet.publicKey?.toBase58() || '')}
                  </p>
                )}

                {wallet.connected && (
                  <p>Balance: {(balance || 0).toLocaleString()} SOL</p>
                )} */}
              </Grid>
            </Paper>
          </Container>

          {fairLaunch && (
            <Container
              maxWidth="xs"
              style={{ position: 'relative', marginTop: 10 }}
            >
              <div style={{ margin: 20 }}>
                <Grid container direction="row" wrap="nowrap">
                  <Grid container md={4} direction="column">
                    <Typography variant="body2" color="textSecondary">
                      Bids
                    </Typography>
                    <Typography
                      variant="h6"
                      color="textPrimary"
                      style={{ fontWeight: 'bold' }}
                    >
                      {fairLaunch?.state.numberTicketsSold.toNumber() || 0}
                    </Typography>
                  </Grid>
                  <Grid container md={4} direction="column">
                    <Typography variant="body2" color="textSecondary">
                      Median bid
                    </Typography>
                    <Typography
                      variant="h6"
                      color="textPrimary"
                      style={{ fontWeight: 'bold' }}
                    >
                      ◎ {formatNumber.format(median)}
                    </Typography>
                  </Grid>
                  <Grid container md={4} direction="column">
                    <Typography variant="body2" color="textSecondary">
                      Total raised
                    </Typography>
                    <Typography
                      variant="h6"
                      color="textPrimary"
                      style={{ fontWeight: 'bold' }}
                    >
                      ◎{' '}
                      {formatNumber.format(
                        (fairLaunch?.treasury || 0) / LAMPORTS_PER_SOL,
                      )}
                    </Typography>
                  </Grid>
                </Grid>
              </div>
            </Container>
          )}
        </div>
        <div className="right">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <video className="image1" src="/media/turntables/Solana_movie_ape.mp4" autoPlay loop />
            <video className="image2" src="/media/turntables/Solana_movie_bull.mp4" autoPlay loop />
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="image34">
              <video className="image3" src="/media/turntables/Solana_movie_tram.mp4" autoPlay loop />
              <video className="image4" src="/media/turntables/Solana_movie_whale.mp4" autoPlay loop />
            </div>
            <video className="image5" src="/media/turntables/Solana_movie_house.mp4" autoPlay loop />
          </div>
        </div>

      </div>
      <Snackbar
        open={alertState.open}
        autoHideDuration={6000}
        onClose={() => setAlertState({ ...alertState, open: false })}
      >
        <Alert
          onClose={() => setAlertState({ ...alertState, open: false })}
          severity={alertState.severity}
        >
          {alertState.message}
        </Alert>
      </Snackbar>
    </Container>
  );
};

interface AlertState {
  open: boolean;
  message: string;
  severity: 'success' | 'info' | 'warning' | 'error' | undefined;
}

export default Home;
