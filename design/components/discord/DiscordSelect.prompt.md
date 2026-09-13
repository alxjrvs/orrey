One-line: how players answer a date poll — tick every date you can make, up to the ten a poll may carry.

```jsx
<DiscordSelect open placeholder="Which days can you make?" selected={['Sat 11 Oct']}
  options={[{label:'Sat 04 Oct',count:3},{label:'Sat 11 Oct',count:6},{label:'Sat 18 Oct',count:2}]} />
```

Counts on the right are the running tally per date. The organiser's **Canonise** button sits beneath as a separate row — winning is the organiser's call, not the arithmetic's.
