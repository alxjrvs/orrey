import React from 'react';

const fills={in:'var(--state-in)',maybe:'var(--state-maybe)',out:'var(--state-out)'};

export function QuorumMeter({inCount=0,maybeCount=0,outCount=0,total=0,quorum,showCount=true,size=11,style,...rest}){
  const pips=[];
  for(let i=0;i<inCount;i++) pips.push('in');
  for(let i=0;i<maybeCount;i++) pips.push('maybe');
  for(let i=0;i<outCount;i++) pips.push('out');
  while(pips.length<total) pips.push('silent');
  const short=quorum!=null&&inCount<quorum;
  return (
    <div style={{display:'flex',alignItems:'center',gap:1,...style}} {...rest}>
      {pips.map((k,i)=>(
        <i key={i} style={{width:size,height:size,flex:'none',
          background:fills[k]||'var(--state-silent-bg)',
          border:'1px solid '+(fills[k]||'var(--line-structural)'),
          boxSizing:'border-box'}}/>
      ))}
      {showCount&&(
        <span style={{marginLeft:'var(--space-4)',font:'var(--type-data)',
          color:short?'var(--state-maybe-text)':'var(--text-secondary)'}}>
          {inCount}/{total}{short?' · needs '+(quorum-inCount):''}
        </span>
      )}
    </div>
  );
}
