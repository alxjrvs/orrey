import React from 'react';

export function SegmentedFilter({options=[],value,onChange,style,...rest}){
  return (
    <div style={{display:'inline-flex',border:'1px solid var(--line-structural)',...style}} {...rest}>
      {options.map((o,i)=>{
        const v=typeof o==='string'?o:o.value, l=typeof o==='string'?o:o.label;
        const on=v===value;
        return (
          <button key={v} type="button" aria-pressed={on} onClick={()=>onChange&&onChange(v)}
            style={{background:on?'var(--action-bg)':'transparent',
              color:on?'var(--action-ink)':'var(--text-secondary)',
              border:0,borderRight:i<options.length-1?'1px solid var(--line-structural)':0,
              font:'var(--type-label)',fontWeight:500,letterSpacing:'0.08em',
              textTransform:'uppercase',padding:'7px 11px',cursor:'pointer',
              transition:'var(--transition-hover)'}}>{l}</button>
        );
      })}
    </div>
  );
}
