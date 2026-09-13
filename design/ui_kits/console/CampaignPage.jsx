const {Panel,Button,Pill,Field,Input,Select,Checkbox,DataTable,Cell,RosterRow,Tag,QuorumMeter}=window.OrreyDesignSystem_4c8cbd;

function CampaignPage({campaign}){
  const c=campaign;
  const sessions=window.ORREY.agenda.filter(a=>a.campaign===c.id);
  const [auto,setAuto]=React.useState(c.id==='umbra');
  const stateTone={RUNNING:'in',FORMING:'accent',HIATUS:'maybe',CONCLUDED:'idle'}[c.state];
  return (
    <main style={{overflow:'auto',padding:'var(--space-8) var(--chrome-gutter) var(--space-10)'}}>
      <div style={{display:'flex',alignItems:'center',gap:'var(--space-6)'}}>
        <i style={{width:10,height:10,background:c.color}}/>
        <h1 style={{font:'var(--type-title)',margin:0}}>{c.name}</h1>
        <Pill tone={stateTone}>{c.state}</Pill>
        <Tag>{c.channel}</Tag>
        <Button variant="primary" style={{marginLeft:'auto'}}>Post next session</Button>
      </div>
      <p style={{font:'var(--type-small)',color:'var(--text-secondary)',maxWidth:'62ch',marginTop:'var(--space-5)'}}>
        {c.state==='FORMING'
          ? 'Signup buttons are live. A closed roster never reopens on its own — reopen it here if someone drops before session one.'
          : 'Signups are closed. Attendance posts go out on the cadence below; the roster is fixed until you change it.'}
      </p>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'var(--space-8)',marginTop:'var(--space-8)'}}>
        <Panel title="Cadence">
          <div style={{display:'grid',gap:'var(--space-6)'}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'var(--space-6)'}}>
              <Field label="Anchor date" hint="May sit in the past."><Input defaultValue="2025-02-06"/></Field>
              <Field label="Interval (weeks)"><Input defaultValue={c.id==='umbra'?'1':'2'}/></Field>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'var(--space-6)'}}>
              <Field label="Quorum" hint="Minimum for it to run."><Input defaultValue={String(c.quorum)}/></Field>
              <Field label="Location"><Select options={['External venue','Voice channel']}/></Field>
            </div>
            <Field label="First session number" hint="History starts empty; seed the count.">
              <Input defaultValue={String(c.sessions+1)}/></Field>
            <Checkbox checked={auto} onChange={setAuto} label="Auto-resolve this campaign's date polls"/>
            <p style={{font:'var(--type-small)',color:'var(--text-muted)',margin:0}}>
              Never onto a date the GM has not marked available.</p>
          </div>
        </Panel>

        <Panel title="Roster" meta={c.roster+' of '+c.roster} actions={<Button size="sm">Add</Button>}>
          {window.ORREY.people.filter(p=>p.on.includes(c.id)).map(p=>(
            <RosterRow key={p.id} name={p.name} initials={p.initials}
              role={p.name===c.gm?'GM':undefined}
              intent={p.dm==='closed'?'maybe':'in'}
              note={p.dm==='closed'?'dms closed':undefined}/>
          ))}
          <p style={{font:'var(--type-small)',color:'var(--text-muted)',margin:'var(--space-6) 0 0'}}>
            A player with DMs closed is reminded by channel mention instead. Orrey learns this from error 50007 and does not retry.</p>
        </Panel>
      </div>

      <div style={{marginTop:'var(--space-8)'}}>
        <Panel title="Sessions" meta={sessions.length+' in horizon'} flush>
          <DataTable columns={[{label:'When',width:110},{label:'Session'},{label:'Venue',width:200},{label:'State',width:120}]}>
            {sessions.map(s=>{
              const t=window.tally(s.roster);
              return (
                <tr key={s.id} style={{borderBottom:'1px solid var(--line-hair)'}}>
                  <Cell style={{font:'var(--type-data)'}}>{s.when} · {s.time}</Cell>
                  <Cell><span style={{font:'var(--type-body-medium)'}}>{s.title}</span>
                    <div style={{font:'var(--type-log)',lineHeight:1.4,color:'var(--text-muted)'}}>{s.sub}</div></Cell>
                  <Cell style={{font:'var(--type-log)',color:'var(--text-secondary)'}}>{s.venue}</Cell>
                  <Cell><QuorumMeter {...t} quorum={c.quorum} size={9}/></Cell>
                </tr>
              );
            })}
          </DataTable>
        </Panel>
      </div>
    </main>
  );
}
Object.assign(window,{CampaignPage});
