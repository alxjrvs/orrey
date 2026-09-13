import React from 'react';

export function TopBar({children,style,...rest}){
  return (
    <header style={{display:'flex',alignItems:'center',gap:'var(--space-7)',
      height:'var(--chrome-topbar)',padding:'0 var(--space-7)',
      background:'var(--surface-chrome)',borderBottom:'1px solid var(--line-structural)',
      ...style}} {...rest}>{children}</header>
  );
}

export function Wordmark({size=13,style,...rest}){
  return (
    <span style={{font:'var(--font-ui)',fontWeight:700,fontSize:size,lineHeight:1,
      letterSpacing:'var(--tracking-wordmark)',textTransform:'uppercase',
      color:'var(--text-primary)',whiteSpace:'nowrap',...style}} {...rest}>
      Orrey<b style={{color:'var(--signal-500)'}}>·</b>of Worlds
    </span>
  );
}
