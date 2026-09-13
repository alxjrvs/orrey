import React from 'react';

export function Tag({mono=true,children,style,...rest}){
  return (
    <span style={{display:'inline-flex',alignItems:'center',padding:'4px 6px',
      border:'1px solid var(--line-structural)',borderRadius:'var(--radius-none)',
      font:mono?'var(--type-label)':'var(--type-small)',fontWeight:500,
      letterSpacing:'var(--tracking-data)',color:'var(--text-muted)',...style}} {...rest}>
      {children}
    </span>
  );
}
