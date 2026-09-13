import React from 'react';

export function DataTable({columns=[],children,style,...rest}){
  return (
    <table style={{width:'100%',borderCollapse:'collapse',
      borderTop:'1px solid var(--line-structural)',...style}} {...rest}>
      <thead><tr>
        {columns.map((c,i)=>(
          <th key={i} style={{width:c.width,textAlign:c.align||'left',
            font:'var(--type-micro)',letterSpacing:'var(--tracking-label)',textTransform:'uppercase',
            color:'var(--text-muted)',padding:'var(--space-4) var(--space-5)',
            background:'var(--surface-chrome)',
            borderBottom:'1px solid var(--line-structural)'}}>{c.label}</th>
        ))}
      </tr></thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function Cell({children,style,...rest}){
  return <td style={{padding:'var(--space-4) var(--space-5)',verticalAlign:'middle',...style}} {...rest}>{children}</td>;
}
