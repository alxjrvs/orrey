import React from 'react';

export function Checkbox({checked=false,label,onChange,disabled=false,style,...rest}){
  return (
    <label style={{display:'inline-flex',alignItems:'center',gap:'var(--space-5)',
      cursor:disabled?'not-allowed':'pointer',opacity:disabled?0.4:1,...style}} {...rest}>
      <span onClick={()=>!disabled&&onChange&&onChange(!checked)}
        style={{width:14,height:14,flex:'none',display:'grid',placeItems:'center',
          border:'1px solid '+(checked?'var(--signal-500)':'var(--line-strong)'),
          background:checked?'var(--signal-500)':'var(--surface-sunken)',
          transition:'var(--transition-hover)'}}>
        {checked&&<i style={{width:6,height:3,borderLeft:'1.5px solid var(--action-ink)',
          borderBottom:'1.5px solid var(--action-ink)',transform:'rotate(-45deg) translate(0.5px,-1px)'}}/>}
      </span>
      {label&&<span style={{font:'var(--type-body)'}}>{label}</span>}
    </label>
  );
}
