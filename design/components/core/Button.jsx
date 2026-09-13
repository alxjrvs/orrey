import React from 'react';

const base={display:'inline-flex',alignItems:'center',justifyContent:'center',gap:'var(--space-3)',
  border:'1px solid transparent',borderRadius:'var(--radius-none)',cursor:'pointer',
  fontFamily:'var(--font-mono)',fontWeight:700,textTransform:'uppercase',
  letterSpacing:'var(--tracking-data)',whiteSpace:'nowrap',
  transition:'var(--transition-hover)'};

const sizes={
  sm:{height:'var(--control-sm)',padding:'0 var(--space-5)',fontSize:'var(--size-micro)',letterSpacing:'0.12em'},
  md:{height:'var(--control-md)',padding:'0 var(--space-6)',fontSize:'var(--size-label)',letterSpacing:'0.09em'},
  lg:{height:'var(--control-lg)',padding:'0 var(--space-8)',fontSize:'var(--size-data)',letterSpacing:'0.09em'}
};

const variants={
  primary:{background:'var(--action-bg)',color:'var(--action-ink)'},
  secondary:{background:'transparent',borderColor:'var(--line-structural)',color:'var(--text-primary)'},
  ghost:{background:'transparent',color:'var(--text-secondary)'},
  danger:{background:'transparent',borderColor:'var(--state-out-line)',color:'var(--state-out-text)'}
};

const hovers={
  primary:{background:'var(--action-bg-hover)'},
  secondary:{background:'var(--surface-raised)',borderColor:'var(--line-strong)'},
  ghost:{background:'var(--surface-raised)',color:'var(--text-primary)'},
  danger:{background:'var(--state-out-bg)',borderColor:'var(--state-out)'}
};

export function Button({variant='secondary',size='md',disabled=false,full=false,children,style,...rest}){
  const [hot,setHot]=React.useState(false);
  return (
    <button type="button" disabled={disabled}
      onMouseEnter={()=>setHot(true)} onMouseLeave={()=>setHot(false)}
      style={{...base,...sizes[size],...variants[variant],...(hot&&!disabled?hovers[variant]:null),
        width:full?'100%':undefined,opacity:disabled?0.4:1,
        cursor:disabled?'not-allowed':'pointer',...style}} {...rest}>
      {children}
    </button>
  );
}
