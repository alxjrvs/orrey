One-line: the console's main list surface — sessions, players, polls, jobs.

```jsx
<DataTable columns={[{label:'When',width:92},{label:'Session'},{label:'Responses',width:190},{label:'Status',width:114}]}>
  <SessionRow … />
</DataTable>
```

No zebra striping, no vertical rules, no row shadows. Selection is an inset accent bar on the row. Put it in a `flush` Panel or directly on the page.
