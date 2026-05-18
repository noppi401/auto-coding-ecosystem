import React, { useState } from 'react';
import { useApp } from 'ink';
import { RunScreen } from './screens/RunScreen.js';
import { SummaryScreen } from './screens/SummaryScreen.js';

type Screen = 'run' | 'summary';

interface Props {
  runFn: () => Promise<void>;
}

export const App: React.FC<Props> = ({ runFn }) => {
  const { exit } = useApp();
  const [screen, setScreen]       = useState<Screen>('run');
  const [runInstance, setRunInstance] = useState(0);
  const [startMs]                 = useState(Date.now());

  const handleComplete = () => {
    setScreen('summary');
  };

  const handleRestart = () => {
    setRunInstance((n) => n + 1);
    setScreen('run');
  };

  if (screen === 'summary') {
    return <SummaryScreen durationMs={Date.now() - startMs} onRestart={handleRestart} />;
  }

  return <RunScreen key={runInstance} runFn={runFn} onComplete={handleComplete} />;
};
