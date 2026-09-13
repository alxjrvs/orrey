One-line: narrows a list to one slice — All / At risk / Confirmed / Unposted.

```jsx
<SegmentedFilter options={['All','At risk','Confirmed','Unposted']} value={f} onChange={setF} />
```

Four options is the practical ceiling; beyond that use a Select. Labels name the resulting set, not the act of filtering.
