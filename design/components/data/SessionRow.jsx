import React from 'react';
import { Cell } from './DataTable.jsx';
import { QuorumMeter } from './QuorumMeter.jsx';
import { Pill } from '../core/Pill.jsx';

const toneFor=s=>({confirmed:'in',jeopardy:'maybe',open:'accent',unposted:'idle',cancelled:'out',played:'neutral'})[s]||'neutral';
const labelFor=s=>({confirmed:'Confirmed',jeopardy:'Quorum short',open:'Poll open',unposted:'Unposted',cancelled:'Cancelled',played:'Played'})[s]||s;

export function SessionRow({when,time,inlineTime=false,title,subtitle,attendance,state='confirmed',selected=false,onClick,style,...rest}){
  const [hot,setHot]=React.useState(false);
  return (
    <tr onClick={onClick} onMouseEnter={()=>setHot(true)} onMouseLeave={()=>setHot(false)}
      aria-selected={selected}
      style={{borderBottom:'1px solid var(--line-hair)',cursor:'pointer',
        background:selected||hot?'var(--surface-raised)':'transparent',
        boxShadow:selected?'var(--marker-selected)':'none',
        transition:'var(--transition-hover)',...style}} {...rest}>
      {!inlineTime&&(
        <Cell style={{font:'var(--type-data)',whiteSpace:'nowrap'}}>
          {when}{time&&<><br/><span style={{color:'var(--text-muted)',fontWeight:400}}>{time}</span></>}
        </Cell>
      )}
      <Cell>
        <div style={{display:'flex',alignItems:'baseline',gap:'var(--space-6)'}}>
          {inlineTime&&time&&(
            <span style={{font:'var(--type-data)',color:'var(--text-muted)',flex:'none'}}>{time}</span>
          )}
          <div style={{minWidth:0}}>
            <div style={{font:'var(--type-body-medium)'}}>{title}</div>
            {subtitle&&<div style={{font:'var(--type-log)',lineHeight:1.4,color:'var(--text-muted)',marginTop:2}}>{subtitle}</div>}
          </div>
        </div>
      </Cell>
      <Cell>{attendance?<QuorumMeter {...attendance}/>:null}</Cell>
      <Cell><Pill tone={toneFor(state)} dot={state==='open'}>{labelFor(state)}</Pill></Cell>
    </tr>
  );
}
