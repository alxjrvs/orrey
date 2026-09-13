const {SegmentedFilter,TopBar,Wordmark,Tag}=window.OrreyDesignSystem_4c8cbd;

function EntryApp(){
  const [v,setV]=React.useState('Sign in');
  return (
    <div style={{minHeight:'100vh'}}>
      <TopBar>
        <Wordmark/>
        <Tag>ENTRY POINTS</Tag>
        <div style={{marginLeft:'auto'}}>
          <SegmentedFilter options={['Sign in','First run','Calendar']} value={v} onChange={setV}/>
        </div>
      </TopBar>
      {v==='Sign in'&&<Login/>}
      {v==='First run'&&<FirstRun/>}
      {v==='Calendar'&&<CalendarView/>}
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<EntryApp/>);
