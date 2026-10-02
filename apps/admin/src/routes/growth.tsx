import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { GrowthScreen } from '@/components/growth/growth-screen';

function Screen(): React.JSX.Element {
  return <GrowthScreen />;
}

export const Route = createFileRoute('/growth')({
  component: Screen,
});
