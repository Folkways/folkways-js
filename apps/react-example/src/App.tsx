import './App.css'
import {Client} from '@folkways/realtime';

  Client({
    token: 'your-token-here',
    segment: 'your-segment-here',
  });

function App() {

  return (
    <>
      Hello Folkways Realtime!
    </>
  )
}

export default App
