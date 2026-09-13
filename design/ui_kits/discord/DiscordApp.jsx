const ROSTER=[
  {name:'Rowan',intent:'in'},{name:'Tam',intent:'in'},{name:'Jodie',intent:'in'},
  {name:'Priya',intent:'in'},{name:'Marco',intent:'out'},{name:'Elle',intent:'silent'}
];

function DiscordApp(){
  const [roster,setRoster]=React.useState(ROSTER);
  const [asOf,setAsOf]=React.useState('19:02');
  const [picked,setPicked]=React.useState(['Sat 11 Oct']);
  const vote=intent=>{
    setRoster(r=>r.map(p=>p.name==='Elle'?{...p,intent}:p));
    setAsOf(new Date().toTimeString().slice(0,5));
  };
  const toggle=v=>setPicked(s=>s.includes(v)?s.filter(x=>x!==v):[...s,v]);
  return (
    <DiscordChrome channel="session-planning">
      <AttendancePost state={{roster,quorum:4,asOf}} onVote={vote}
        onRefresh={()=>setAsOf(new Date().toTimeString().slice(0,5))}/>
      <SignupPost/>
      <PollPost picked={picked} onToggle={toggle}/>
      <JeopardyNotice/>
      <UpcomingReply/>
      <RetiredPost/>
    </DiscordChrome>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<DiscordApp/>);
