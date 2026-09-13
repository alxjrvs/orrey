import React from 'react';

export function Panel({title,meta,actions,flush=false,children,style,...rest}){
  return (
    <section style={{border:'1px solid var(--line-structural)',background:'var(--surface-chrome)',
      borderRadius:'var(--radius-none)',...style}} {...rest}>
      {(title||actions)&&(
        <header style={{display:'flex',alignItems:'center',gap:'var(--space-6)',
          padding:'var(--space-5) var(--space-7)',borderBottom:'1px solid var(--line-structural)'}}>
          <span style={{font:'var(--type-label)',letterSpacing:'var(--tracking-label)',
            textTransform:'uppercase',color:'var(--text-muted)'}}>{title}</span>
          {meta&&<span style={{font:'var(--type-data)',fontWeight:400,color:'var(--text-secondary)'}}>{meta}</span>}
          {actions&&<div style={{marginLeft:'auto',display:'flex',gap:'var(--space-3)'}}>{actions}</div>}
        </header>
      )}
      <div style={{padding:flush?0:'var(--space-7)'}}>{children}</div>
    </section>
  );
}
