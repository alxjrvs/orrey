import React from 'react';

export function Select({options=[],style,...rest}){
  return (
    <div style={{position:'relative',...style}}>
      <select style={{width:'100%',height:'var(--control-md)',padding:'0 26px 0 var(--space-5)',
        background:'var(--surface-sunken)',color:'var(--text-primary)',
        border:'1px solid var(--line-structural)',borderRadius:'var(--radius-none)',
        font:'var(--type-body)',appearance:'none',outline:'none',cursor:'pointer'}} {...rest}>
        {options.map(o=>{
          const v=typeof o==='string'?o:o.value, l=typeof o==='string'?o:o.label;
          return <option key={v} value={v}>{l}</option>;
        })}
      </select>
      <i style={{position:'absolute',right:9,top:'50%',marginTop:-2,width:0,height:0,
        borderLeft:'4px solid transparent',borderRight:'4px solid transparent',
        borderTop:'4px solid var(--text-muted)',pointerEvents:'none'}}/>
    </div>
  );
}
