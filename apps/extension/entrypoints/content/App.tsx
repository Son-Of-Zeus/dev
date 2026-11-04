import Companion from '../../companion/Companion';
import type { CompanionUiStore } from '../../companion/companion-ui';

type AppProps = {
  store: CompanionUiStore;
};

export default function App({ store }: AppProps) {
  return <Companion store={store} />;
}
