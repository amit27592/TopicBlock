"""
Unit tests for WP-7 and WP-8 models.
"""

from unittest.mock import MagicMock, patch
import pytest

from topicblock_native.models.registry import registry
from topicblock_native.models.base import NullTopicModel, NullSentimentModel
from topicblock_native.models.topic_minilm import MiniLMTopicModel
from topicblock_native.models.topic_bge import BGETopicModel
from topicblock_native.models.sentiment_vader import VaderSentimentModel
from topicblock_native.models.sentiment_distilbert import DistilBertSentimentModel


def test_registry_null_fallbacks():
    # Registry should fall back to Null versions for unknown names
    topic_model = registry.get_topic_model("unknown-topic")
    assert isinstance(topic_model, NullTopicModel)
    
    sentiment_model = registry.get_sentiment_model("unknown-sentiment")
    assert isinstance(sentiment_model, NullSentimentModel)


@patch("topicblock_native.models.topic_minilm.SentenceTransformer")
def test_minilm_topic_model(mock_st):
    # Mock sentence-transformers to return an array
    mock_instance = MagicMock()
    mock_instance.encode.return_value = [[0.1, 0.2], [0.3, 0.4]]
    mock_st.return_value = mock_instance

    model = MiniLMTopicModel()
    model.warmup()
    
    mock_st.assert_called_once_with("sentence-transformers/all-MiniLM-L6-v2")
    
    embeddings = model.embed(["test text 1", "test text 2"])
    
    # Assert encode was called with correct parameters
    mock_instance.encode.assert_called_once_with(
        ["test text 1", "test text 2"], 
        convert_to_numpy=True, 
        normalize_embeddings=True
    )
    assert len(embeddings) == 2


@patch("topicblock_native.models.topic_bge.SentenceTransformer")
def test_bge_topic_model(mock_st):
    mock_instance = MagicMock()
    mock_instance.encode.return_value = [[0.5, 0.5]]
    mock_st.return_value = mock_instance

    model = BGETopicModel()
    model.warmup()
    
    mock_st.assert_called_once_with("BAAI/bge-small-en-v1.5")
    
    embeddings = model.embed(["test text"])
    mock_instance.encode.assert_called_once()
    assert len(embeddings) == 1


@patch("topicblock_native.models.sentiment_vader.SentimentIntensityAnalyzer")
def test_vader_sentiment_model(mock_vader):
    mock_instance = MagicMock()
    mock_instance.polarity_scores.return_value = {
        "neg": 0.1, "neu": 0.4, "pos": 0.5, "compound": 0.8
    }
    mock_vader.return_value = mock_instance

    model = VaderSentimentModel()
    model.warmup()
    
    scores = model.score(["great tool"])
    
    # polarity = compound (0.8), magnitude = 1.0 - neu (0.6)
    assert len(scores) == 1
    assert scores[0][0] == 0.8
    assert abs(scores[0][1] - 0.6) < 1e-6


@patch("topicblock_native.models.sentiment_distilbert.pipeline")
def test_distilbert_sentiment_model(mock_pipeline):
    mock_instance = MagicMock()
    mock_instance.return_value = [
        {"label": "POSITIVE", "score": 0.95},
        {"label": "NEGATIVE", "score": 0.8}
    ]
    mock_pipeline.return_value = mock_instance

    model = DistilBertSentimentModel()
    model.warmup()
    
    scores = model.score(["good", "bad"])
    
    assert len(scores) == 2
    
    # first score (POSITIVE 0.95) -> polarity=0.95, magnitude=0.95
    assert scores[0] == (0.95, 0.95)
    
    # second score (NEGATIVE 0.8) -> polarity=-0.8, magnitude=0.8
    assert scores[1] == (-0.8, 0.8)
