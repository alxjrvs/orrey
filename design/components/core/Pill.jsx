import React from 'react';

const tones={
  neutral:{color:'var(--text-secondary)',borderColor:'var(--line-structural)',background:'transparent'},
  in:{color:'var(--state-in-text)',borderColor:'var(--state-in-line)',background:'var(--state-in-bg)'},
  maybe:{color:'var(--state-maybe-text)',borderColor:'var(--state-maybe-line)',background:'var(--state-maybe-bg)'},
  out:{color:'var(--state-out-text)',borderColor:'var(--state-out-line)',background:'var(--state-out-bg)'},
  accent:{color:'var(--signal-400)',borderColor:'var(--signal-600)',background:'var(--signal-100)'},
  idle:{color:'var(--text-muted)',borderColor:'var(--line-hair)',background:'transparent'}
};

export function Pill({tone='neutral',dot=false,children,style,...rest}){
  return (
    <span style={{display:'inline-flex',alignItems:'center',gap:'var(--space-3)',
      font:'var(--type-micro)',letterSpacing:'0.12em',textTransform:'uppercase',
      padding:'5px 9px',borderRadius:'var(--radius-pill)',border:'1px solid',
      ...tones[tone],...style}} {...rest}>
      {dot&&<i style={{width:5,height:5,borderRadius:'var(--radius-circle)',background:'currentColor'}}/>}
      {children}
    </span>
  );
}
