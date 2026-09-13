const {Panel,Button,Pill,Select,Field,Checkbox,Tag,DataTable,Cell}=window.OrreyDesignSystem_4c8cbd;

function PollPage(){
  const p=window.ORREY.poll;
  const [picked,setPicked]=React.useState(p.dates.filter(d=>d.winning).map(d=>d.date));
  const toggle=d=>setPicked(s=>s.includes(d)?s.filter(x=>x!==d):[...s,d]);
  const max=Math.max(...p.dates.map(d=>d.count));
  return (
    <main style={{overflow:'auto',padding:'var(--space-8) var(--chrome-gutter) var(--space-10)'}}>
      <div style={{display:'flex',alignItems:'center',gap:'var(--space-6)'}}>
        <h1 style={{font:'var(--type-title)',margin:0}}>Date poll · no target</h1>
        <Pill tone="accent" dot>Open</Pill>
        <Tag>closes {p.closes}</Tag>
      </div>
      <p style={{font:'var(--type-small)',color:'var(--text-secondary)',maxWidth:'64ch',marginTop:'var(--space-5)'}}>
        One mechanism, two uses. With no target, winning dates are minted as game days —
        one poll may produce several. With a target, the poll moves that session instead.
        Winning is contextual and yours to call.
      </p>

      <div style={{display:'grid',gridTemplateColumns:'1fr 300px',gap:'var(--space-8)',marginTop:'var(--space-8)',alignItems:'start'}}>
        <Panel title="Candidate dates" meta={p.dates.length+' of 10'} flush>
          <div>
            {p.dates.map(d=>{
              const on=picked.includes(d.date);
              return (
                <div key={d.date} onClick={()=>toggle(d.date)}
                  style={{display:'grid',gridTemplateColumns:'18px 150px 1fr 64px',gap:'var(--space-6)',
                    alignItems:'center',padding:'var(--space-5) var(--space-7)',cursor:'pointer',
                    borderBottom:'1px solid var(--line-hair)',
                    boxShadow:on?'var(--marker-selected)':'none',
                    background:on?'var(--surface-raised)':'transparent'}}>
                  <i style={{width:14,height:14,border:'1px solid '+(on?'var(--signal-500)':'var(--line-strong)'),
                    background:on?'var(--signal-500)':'transparent'}}/>
                  <span style={{font:'var(--type-body-medium)'}}>{d.date}</span>
                  <span style={{display:'flex',alignItems:'center',gap:'var(--space-4)'}}>
                    <i style={{height:8,width:(d.count/max*100)+'%',maxWidth:200,
                      background:d.count>=p.threshold?'var(--state-in)':'var(--state-silent-bg)',
                      border:'1px solid '+(d.count>=p.threshold?'var(--state-in)':'var(--line-structural)'),
                      transition:'var(--transition-meter)'}}/>
                    <span style={{font:'var(--type-log)',lineHeight:1,color:'var(--text-muted)',
                      overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{d.who.join(', ').toLowerCase()}</span>
                  </span>
                  <span style={{font:'var(--type-data)',textAlign:'right',
                    color:d.count>=p.threshold?'var(--state-in-text)':'var(--text-muted)'}}>{d.count}</span>
                </div>
              );
            })}
          </div>
        </Panel>

        <div style={{display:'grid',gap:'var(--space-7)'}}>
          <Panel title="Win rule">
            <div style={{display:'grid',gap:'var(--space-6)'}}>
              <Field label="Rule"><Select options={['Game minimum','Quorum of roster','Best available','Organiser picks']}/></Field>
              <div style={{display:'flex',gap:'var(--space-6)',alignItems:'baseline'}}>
                <span style={{font:'var(--type-log)',color:'var(--text-muted)'}}>threshold</span>
                <span style={{font:'var(--type-data)'}}>{p.threshold} players</span>
              </div>
              <Checkbox checked label="Override always available"/>
              <p style={{font:'var(--type-small)',color:'var(--text-muted)',margin:0}}>
                Two dates currently clear the threshold. Canonising both mints two game days.</p>
            </div>
          </Panel>
          <Panel title="Outcome">
            <div style={{display:'grid',gap:'var(--space-5)'}}>
              {picked.length===0
                ? <span style={{font:'var(--type-small)',color:'var(--text-muted)'}}>Nothing selected.</span>
                : picked.map(d=><span key={d} style={{font:'var(--type-body-medium)'}}>{d}</span>)}
              <Button variant="primary" full>Canonise {picked.length} {picked.length===1?'date':'dates'}</Button>
              <Button full>Close poll without minting</Button>
            </div>
          </Panel>
        </div>
      </div>
    </main>
  );
}
Object.assign(window,{PollPage});
