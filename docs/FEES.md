# Fee calculation

`core/fees/` is the one place fee arithmetic lives. The same asset, amount and
schedule always produce the same breakdown, and every fee comes with a line
item that explains how it was reached.

## Rules

- **Smallest units, `bigint`.** An amount is a count of the asset's smallest
  unit (stroops for a 7-decimal Stellar asset). Nothing passes through `Number`.
- **Per-line rounding.** Each line's rate amount is
  `amount * basisPoints / 10000`, rounded **half up** to the smallest unit,
  independently of every other line.
- **Minimums.** A line's `minimum` applies to any positive amount and only then.
  A zero amount is never charged a minimum.
- **Fees can never exceed the amount.** If the lines add up to more than the
  gross amount, the calculation is refused with `fees_exceed_amount`.
- **No hidden inputs.** No clock, randomness or ambient state is read.

## Using it

```ts
import { calculateFees, explainFees, parseAssetAmount } from "@/core/fees";

const asset = { code: "XLM", decimals: 7 };
const amount = parseAssetAmount(asset, "100"); // { ok: true, value: 1000000000n }

const result = calculateFees({
  asset,
  amount: amount.value,
  schedule: {
    lines: [
      { id: "protocol", label: "Protocol fee", basisPoints: 100, minimum: 100_000n },
      { id: "organizer", label: "Organizer fee", basisPoints: 250 }
    ]
  }
});

if (result.ok) {
  explainFees(result.value);
  // [
  //   "Protocol fee: 1.00% of 100.0000000 XLM = 1.0000000 XLM (rounded half up)",
  //   "Organizer fee: 2.50% of 100.0000000 XLM = 2.5000000 XLM (rounded half up)",
  //   "Total fees: 3.5000000 XLM",
  //   "Net: 96.5000000 XLM"
  // ]
}
```

`calculateFees` has no side effects, so calling it is the preview a user sees
before final submission; submitting stores the same figures.

## Matching stored settlements

`reconcileFees(breakdown, stored)` compares a breakdown with the figures a
settlement record stored (`gross`, one amount per line id, `net`) and reports
every field that differs, including a missing or extra line. The seed dataset
(see [SEED_DATA.md](./SEED_DATA.md)) uses it to prove its settlements agree with
the module.

## Errors

| Code                      | Meaning                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `invalid_asset`           | The asset code is not 1-12 alphanumeric characters                   |
| `invalid_asset_precision` | The asset's decimals are not an integer from 0 to 18, or an amount has more fractional digits than the asset allows |
| `invalid_amount`          | The amount is negative or the text is not a plain decimal            |
| `invalid_fee_schedule`    | A duplicate or empty line id, a rate outside 0-10000 bps, or a negative minimum |
| `fees_exceed_amount`      | The lines add up to more than the gross amount                       |

`parseAssetAmount` refuses extra fractional digits instead of rounding them
away, so a user is never charged against an amount they did not type.
