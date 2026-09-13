One-line: the day divider in the grouped agenda.

```jsx
<DataTable columns={cols}>
  <DayHeader lead="02" gutter={86} day="Thursday, October" relative="in 2 days" colSpan={4} />
  <SessionRow … />
</DataTable>
```

The day number sits in its own gutter, the same width as the table's When column, so it reads directly above the times it governs. `day` carries the weekday and month in full; the relative line is lower case: "in 2 days", "tomorrow", "today".
