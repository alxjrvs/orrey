One-line: the console's action control — square, mono, uppercase; use `primary` exactly once per view and outline everything else.

```jsx
<Button variant="primary" size="md">+ Session</Button>
<Button>Nudge 1</Button>
<Button variant="danger" size="sm">Cancel session</Button>
```

Variants: `primary` (accent fill, near-black ink), `secondary` (default, hairline outline), `ghost` (no border, for dense row actions), `danger` (rust outline, never a rust fill). Sizes `sm` 26px / `md` 32px / `lg` 38px. `full` stretches it for the two-up action grid in the detail rail. Labels are short imperatives in sentence case; the component uppercases them.
