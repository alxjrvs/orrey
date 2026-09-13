const {Panel,Button,Pill,RosterRow,SyncLog,QuorumMeter,Tag}=window.OrreyDesignSystem_4c8cbd;

function DetailRail({item}){
  if(!item) return (
    <aside style={{width:'var(--chrome-rail)',flex:'none',borderLeft:'1px solid var(--line-structural)',
      background:'var(--surface-chrome)',display:'grid',placeItems:'center',padding:'var(--space-8)'}}>
      <p style={{font:'var(--type-small)',color:'var(--text-muted)',textAlign:'center',margin:0}}>
        Select a session to see who has answered.</p>
    </aside>);
  const c=window.ORREY.campaigns.find(x=>x.id===item.campaign);
  const t=window.tally(item.roster);
  const short=c&&t.inCount<c.quorum;
  return (
    <aside style={{width:'var(--chrome-rail)',flex:'none',overflow:'auto',
      borderLeft:'1px solid var(--line-structural)',background:'var(--surface-chrome)'}}>
      <div style={{padding:'var(--space-7)'}}>
        <div style={{font:'var(--type-micro)',letterSpacing:'var(--tracking-label)',
          textTransform:'uppercase',color:'var(--text-muted)'}}>{item.day} · {item.time}</div>
        <h2 style={{font:'var(--type-heading)',margin:'var(--space-4) 0 var(--space-2)'}}>{item.title}</h2>
        <div style={{font:'var(--type-log)',lineHeight:1.5,color:'var(--text-secondary)',
          textTransform:'uppercase',letterSpacing:'var(--tracking-data)'}}>
          {item.venue}{c?' · GM '+c.gm:''}</div>
        <div style={{display:'flex',gap:'var(--space-3)',marginTop:'var(--space-6)',flexWrap:'wrap'}}>
          <Tag>{item.kind}</Tag>
          {c&&<Tag>{`quorum ${c.quorum}`}</Tag>}
        </div>
        <div style={{marginTop:'var(--space-7)'}}>
          <QuorumMeter {...t} quorum={c?c.quorum:6} size={13}/>
        </div>
        {short&&(
          <p style={{font:'var(--type-small)',color:'var(--state-maybe-text)',margin:'var(--space-5) 0 0'}}>
            Short of quorum. The answer to that is a date poll, not a cancellation.</p>
        )}
      </div>
      <div style={{borderTop:'1px solid var(--line-structural)',padding:'var(--space-6) var(--space-7)'}}>
        <div style={{font:'var(--type-micro)',letterSpacing:'var(--tracking-label)',textTransform:'uppercase',
          color:'var(--text-muted)',marginBottom:'var(--space-4)'}}>Roster {t.inCount}/{t.total}</div>
        {item.roster.map(([pid,intent,role,note])=>{
          const p=window.ORREY.people.find(x=>x.id===pid)||{name:pid,initials:'??'};
          return <RosterRow key={pid} name={p.name} initials={p.initials} role={role} intent={intent} note={note}/>;
        })}
      </div>
      <div style={{borderTop:'1px solid var(--line-structural)',padding:'var(--space-6) var(--space-7)',
        display:'grid',gridTemplateColumns:'1fr 1fr',gap:'var(--space-2)'}}>
        <Button size="sm" full>Nudge {item.roster.filter(r=>r[1]==='silent').length}</Button>
        <Button size="sm" full>Reschedule</Button>
        <Button size="sm" full>Repost</Button>
        <Button size="sm" full variant="danger">Cancel</Button>
      </div>
      <div style={{borderTop:'1px solid var(--line-structural)',padding:'var(--space-6) var(--space-7)'}}>
        <div style={{font:'var(--type-micro)',letterSpacing:'var(--tracking-label)',textTransform:'uppercase',
          color:'var(--text-muted)',marginBottom:'var(--space-4)'}}>Sync log</div>
        <SyncLog entries={window.ORREY.log}/>
      </div>
    </aside>
  );
}
Object.assign(window,{DetailRail});
