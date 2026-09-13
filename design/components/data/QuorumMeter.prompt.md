One-line: the central readout of the product — whether enough people have said yes.

```jsx
<QuorumMeter inCount={4} outCount={1} total={6} quorum={4} />
<QuorumMeter inCount={2} maybeCount={1} total={5} quorum={5} />
```

Order is fixed: in, maybe, out, then silent. Silent is an empty outline — no reply is not a no. When `inCount` is under `quorum` the trailing count turns amber and appends "needs N"; it never says "cancelled", because the product's answer to a short session is a date poll.
