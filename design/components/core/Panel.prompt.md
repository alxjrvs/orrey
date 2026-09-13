One-line: groups related console content behind one hairline border and a mono caps header.

```jsx
<Panel title="Roster" meta="4 / 6" actions={<Button size="sm">Edit</Button>}>
  …
</Panel>
<Panel title="Sessions" flush><DataTable …/></Panel>
```

Never nest panels, never add a shadow or radius. `flush` when the body is a table — the table supplies its own row rhythm.
