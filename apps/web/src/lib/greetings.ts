export interface Greeting {
  title: string;
  subtitle: string;
}

const NEW_USER_GREETINGS: Greeting[] = [
  { title: 'Welcome to LOME Chat!', subtitle: 'Your AI conversation partner awaits' },
  { title: 'Ready to Get Started?', subtitle: "Ask me anything, I'm here to help" },
  { title: 'Your Journey Starts Here', subtitle: "Let's explore ideas together" },
  { title: 'Welcome, Future Thinker!', subtitle: 'Discover what we can accomplish together' },
  { title: 'Hello There!', subtitle: 'Ready to turn your thoughts into conversations' },
];

const MORNING_GREETINGS: Greeting[] = [
  { title: 'Good Morning!', subtitle: 'What can I help you with today?' },
  { title: 'Rise and Think!', subtitle: 'Your morning conversation awaits' },
  { title: 'Morning Magic!', subtitle: 'Fresh day, fresh ideas' },
  { title: 'Hello, Early Bird!', subtitle: 'The conversation canvas is yours' },
  { title: 'Dawn of Ideas!', subtitle: 'What shall we explore today?' },
];

const AFTERNOON_GREETINGS: Greeting[] = [
  { title: 'Afternoon Adventures!', subtitle: 'What questions are on your mind?' },
  { title: 'Midday Ideas Calling!', subtitle: 'Time to think something through' },
  { title: 'Creative Afternoon!', subtitle: 'Your imagination is the only limit' },
  { title: 'Hello, Daydreamer!', subtitle: "Let's turn those thoughts into action" },
  { title: 'Afternoon Inspiration!', subtitle: 'What shall we discover together?' },
];

const EVENING_GREETINGS: Greeting[] = [
  { title: 'Evening Thinking!', subtitle: 'Golden hour for golden ideas' },
  { title: 'Sunset Conversations!', subtitle: "What's on your mind tonight?" },
  { title: 'Creative Evening!', subtitle: 'Time to wind down with a chat' },
  { title: 'Hello, Twilight Thinker!', subtitle: 'Evening inspiration awaits' },
  { title: 'Twilight Ideas!', subtitle: 'What questions does the evening bring?' },
];

const NIGHT_GREETINGS: Greeting[] = [
  { title: 'Midnight Thoughts!', subtitle: 'When stars align, ideas shine' },
  { title: 'Night Owl Mode!', subtitle: 'The quiet hours spark the best ideas' },
  { title: 'Moonlight Musing!', subtitle: 'What keeps you up tonight?' },
  { title: 'Hello, Nocturnal Thinker!', subtitle: 'The night canvas awaits your thoughts' },
  { title: 'Starlight Conversations!', subtitle: 'What questions emerge under the stars?' },
];

function getRandomGreeting(greetings: Greeting[]): Greeting {
  const index = Math.floor(Math.random() * greetings.length);
  const greeting = greetings[index];
  if (!greeting) {
    return { title: 'Hello!', subtitle: 'How can I help you today?' };
  }
  return greeting;
}

export function getGreeting(isAuthenticated: boolean): Greeting {
  if (!isAuthenticated) {
    return getRandomGreeting(NEW_USER_GREETINGS);
  }

  const hour = new Date().getHours();

  if (hour >= 5 && hour < 12) {
    return getRandomGreeting(MORNING_GREETINGS);
  } else if (hour >= 12 && hour < 17) {
    return getRandomGreeting(AFTERNOON_GREETINGS);
  } else if (hour >= 17 && hour < 21) {
    return getRandomGreeting(EVENING_GREETINGS);
  } else {
    return getRandomGreeting(NIGHT_GREETINGS);
  }
}
