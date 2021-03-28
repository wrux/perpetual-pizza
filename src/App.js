import React, { useState, useEffect } from 'react';
import Pizza from './pizza.gif';
import './App.css';
import { useInterval } from './lib/hooks';

const App = () => {
  const [ spinner, setSpinner ] = useState(true);
  const [ count, setCount ] = useState(0);
  useInterval(() => setCount(count + 1), 2000); // GIF is 2 seconds long.
  useEffect(() => { setTimeout(() => setSpinner(false), 1000) }, []);
  useEffect(() => {document.title = "Perpetual Pizza: " + count});

  if (spinner) {
    return <div className="loading"><p>Loading Pizza</p></div>
  }

  return <div className="app" style={{ backgroundImage: `url(${Pizza})` }}>
    <div className="pizza-counter">
      <p className="title">Pizza watched</p>
      <p className="count">{count}</p>
    </div>
    <div className="credit">
      <a href="https://bloke.blog/" target="_blank" rel="noopener noreferrer" >Bloke</a>
      <a href="http://sheepfilms.co.uk/" target="_blank" rel="noopener noreferrer" >SheepFilms</a>
    </div>
  </div>
}

export default App;
