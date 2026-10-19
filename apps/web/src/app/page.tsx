import { HomeScreen } from '@/components/home-screen';

/**
 * The application has exactly one screen.
 *
 * Matching, chatting and direct requests are all states of the same Socket.IO session,
 * so separate routes would only add navigation the user has to perform manually — and
 * a URL that could be shared or reloaded into a conversation that no longer exists.
 */
export default function Page() {
  return <HomeScreen />;
}
