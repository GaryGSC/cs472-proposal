import pandas as pd
import scipy.io.arff as arff
import numpy as np

repos = np.array(pd.DataFrame(arff.loadarff('./github.arff')[0]), dtype=np.unicode)

print()
