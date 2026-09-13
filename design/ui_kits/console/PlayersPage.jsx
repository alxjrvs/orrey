const {Panel,DataTable,Cell,Button,Pill,Tag,Avatar}=window.OrreyDesignSystem_4c8cbd;

function PlayersPage(){
  const dmTone={open:'in',closed:'out',unknown:'idle'};
  return (
    <main style={{overflow:'auto',padding:'var(--space-8) var(--chrome-gutter) var(--space-10)'}}>
      <div style={{display:'flex',alignItems:'center',gap:'var(--space-6)'}}>
        <h1 style={{font:'var(--type-title)',margin:0}}>Players</h1>
        <span style={{font:'var(--type-log)',lineHeight:1,letterSpacing:'var(--tracking-data)',
          textTransform:'uppercase',color:'var(--text-muted)'}}>{window.ORREY.people.length} known</span>
        <Button style={{marginLeft:'auto'}}>Export ICS tokens</Button>
      </div>
      <p style={{font:'var(--type-small)',color:'var(--text-secondary)',maxWidth:'64ch',marginTop:'var(--space-5)'}}>
        Discord id is the primary key; names are a cache. Flake memory is descriptive, not a
        score — it exists so the organiser can read a silent roster, not to rank anyone.
      </p>
      <div style={{marginTop:'var(--space-8)'}}>
        <Panel title="Roster" flush>
          <DataTable columns={[{label:'Player',width:200},{label:'On',width:220},
            {label:'DMs',width:110},{label:'Missed, last 10',width:140},{label:'Feed',width:110}]}>
            {window.ORREY.people.map(p=>(
              <tr key={p.id} style={{borderBottom:'1px solid var(--line-hair)'}}>
                <Cell><span style={{display:'flex',alignItems:'center',gap:'var(--space-5)'}}>
                  <Avatar initials={p.initials}/>
                  <span style={{font:'var(--type-body-medium)'}}>{p.name}</span></span></Cell>
                <Cell><span style={{display:'flex',gap:4}}>
                  {p.on.map(id=>{const c=window.ORREY.campaigns.find(x=>x.id===id);
                    return <i key={id} title={c.name} style={{width:7,height:7,background:c.color}}/>;})}
                  <span style={{font:'var(--type-log)',lineHeight:1,color:'var(--text-muted)',marginLeft:6}}>
                    {p.on.map(id=>window.ORREY.campaigns.find(x=>x.id===id).name).join(', ').toLowerCase()}</span>
                </span></Cell>
                <Cell><Pill tone={dmTone[p.dm]}>{p.dm}</Pill></Cell>
                <Cell><span style={{font:'var(--type-data)',
                  color:p.flake>0.2?'var(--state-maybe-text)':'var(--text-secondary)'}}>
                  {Math.round(p.flake*10)} of 10</span></Cell>
                <Cell><Tag>ics</Tag></Cell>
              </tr>
            ))}
          </DataTable>
        </Panel>
      </div>
    </main>
  );
}
Object.assign(window,{PlayersPage});
