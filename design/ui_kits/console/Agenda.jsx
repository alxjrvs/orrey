const {DataTable,DayHeader,SessionRow,SegmentedFilter,Button}=window.OrreyDesignSystem_4c8cbd;

const COLS_FLAT=[{label:'When',width:86},{label:'Session'},{label:'Responses',width:170},{label:'Status',width:118}];
const COLS_GROUPED=[{label:'Session'},{label:'Responses',width:170},{label:'Status',width:118}];
const UNSETTLED=['jeopardy','open','unposted'];
const DAYNAME={Mon:'Monday',Tue:'Tuesday',Wed:'Wednesday',Thu:'Thursday',Fri:'Friday',Sat:'Saturday',Sun:'Sunday'};

const VIEWS={
  scheduling:{
    title:"What I'm scheduling",
    lede:"Sessions still waiting on something — an answer, a poll, or a post. Orrey holds a poll for fourteen days; after that the date is yours to move.",
    filters:['All','Quorum short','Poll open','Unposted'],
    match:a=>UNSETTLED.includes(a.state),
    sub:{'Quorum short':a=>a.state==='jeopardy','Poll open':a=>a.state==='open','Unposted':a=>a.state==='unposted'}
  },
  confirmed:{
    title:"What's confirmed",
    lede:"Quorum met, Discord posted, calendar written. Nothing here needs you — it is the record, not the work.",
    filters:['All','Campaign sessions','Game days'],
    match:a=>!UNSETTLED.includes(a.state),
    sub:{'Campaign sessions':a=>a.kind==='campaign_session','Game days':a=>a.kind==='game_day'}
  }
};

function unsettledIds(){return window.ORREY.agenda.filter(a=>UNSETTLED.includes(a.state)).map(a=>a.id)}
function settledIds(){return window.ORREY.agenda.filter(a=>!UNSETTLED.includes(a.state)).map(a=>a.id)}

function tally(roster=[]){
  const c=k=>roster.filter(r=>r[1]===k).length;
  return {inCount:c('in'),maybeCount:c('maybe'),outCount:c('out'),total:roster.length};
}

function Agenda({mode='scheduling',grouped,setGrouped,filter,setFilter,selected,onSelect}){
  const v=VIEWS[mode];
  const f=v.filters.includes(filter)?filter:'All';
  const items=window.ORREY.agenda.filter(v.match).filter(a=>f==='All'?true:v.sub[f](a));

  const rows=[];
  let lastDay=null;
  items.forEach(a=>{
    const q=window.ORREY.campaigns.find(c=>c.id===a.campaign);
    if(grouped&&a.day!==lastDay){
      const parts=a.day.split(' ');
      rows.push(<DayHeader key={'d'+a.id} lead={parts[1]} gutter={62}
        day={(DAYNAME[parts[0]]||parts[0])+', '+parts[2]} relative={a.rel} colSpan={grouped?3:4}/>);
      lastDay=a.day;
    }
    rows.push(<SessionRow key={a.id} inlineTime={grouped} when={a.when} time={a.time}
      title={a.title} subtitle={a.sub} state={a.state}
      attendance={{...tally(a.roster),quorum:q?q.quorum:6}}
      selected={selected===a.id} onClick={()=>onSelect(a.id)}/>);
  });

  return (
    <main style={{overflow:'auto',minWidth:560,padding:'var(--space-8) var(--chrome-gutter) var(--space-10)'}}>
      <div style={{display:'flex',alignItems:'baseline',gap:'var(--space-6)'}}>
        <h1 style={{font:'var(--type-title)',margin:0}}>{v.title}</h1>
        <span style={{font:'var(--type-log)',lineHeight:1,letterSpacing:'var(--tracking-data)',
          textTransform:'uppercase',color:mode==='scheduling'?'var(--state-maybe-text)':'var(--text-muted)'}}>
          {items.length} {mode==='scheduling'?'open':'settled'}</span>
      </div>
      <p style={{font:'var(--type-small)',color:'var(--text-secondary)',maxWidth:'62ch',
        margin:'var(--space-5) 0 0'}}>{v.lede}</p>
      <div style={{display:'flex',gap:'var(--space-3)',alignItems:'center',margin:'var(--space-7) 0 var(--space-5)'}}>
        <SegmentedFilter options={v.filters} value={f} onChange={setFilter}/>
        <SegmentedFilter options={[{value:'grouped',label:'By day'},{value:'flat',label:'Flat'}]}
          value={grouped?'grouped':'flat'} onChange={x=>setGrouped(x==='grouped')}/>
        {mode==='scheduling'&&<Button variant="primary" style={{marginLeft:'auto'}}>+ Session</Button>}
      </div>
      <DataTable columns={grouped?COLS_GROUPED:COLS_FLAT}>{rows}</DataTable>
      {items.length===0&&(
        <p style={{font:'var(--type-small)',color:'var(--text-muted)',padding:'var(--space-9) 0'}}>
          {mode==='scheduling'?'Nothing outstanding. Every session in the horizon has an answer.':'Nothing confirmed in this slice yet.'}</p>
      )}
    </main>
  );
}
Object.assign(window,{Agenda,tally,unsettledIds,settledIds});
