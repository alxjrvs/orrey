import React from 'react';

export function DayHeader({day,relative,lead,gutter=86,colSpan=4,asRow=true,style,...rest}){
  const inner=(
    <div style={{display:'grid',gridTemplateColumns:gutter+'px 1fr',alignItems:'center',
      background:'var(--surface-chrome)',
      borderTop:'1px solid var(--line-structural)',
      borderBottom:'1px solid var(--line-structural)'}}>
      <div style={{padding:'var(--space-5) var(--space-5)',textAlign:'left',
        font:'var(--font-mono)',fontWeight:700,fontSize:'var(--size-title)',lineHeight:1,
        color:'var(--text-primary)',borderRight:'1px solid var(--line-hair)'}}>{lead}</div>
      <div style={{display:'flex',alignItems:'baseline',gap:'var(--space-5)',
        padding:'var(--space-5) var(--space-5)'}}>
        <b style={{font:'var(--type-label)',fontSize:'var(--size-data)',letterSpacing:'0.12em',
          textTransform:'uppercase',color:'var(--text-primary)'}}>{day}</b>
        {relative&&<span style={{font:'var(--type-log)',lineHeight:1,color:'var(--text-muted)'}}>{relative}</span>}
      </div>
    </div>
  );
  if(!asRow) return <div style={style} {...rest}>{inner}</div>;
  return <tr {...rest}><td colSpan={colSpan} style={{padding:0,...style}}>{inner}</td></tr>;
}
